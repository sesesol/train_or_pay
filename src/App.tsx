/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  UserProfile,
  SessionMeta,
  UserWeekData,
  WeekSettlement,
  DebtItem,
  DebtsStorage,
} from './types.ts';
import {
  storageGet,
  storageSet,
  storageList,
  storageDelete,
  initWindowStoragePolyfill,
} from './lib/storage.ts';
import {
  getBerlinISOWeek,
  getNextBerlinISOWeek,
  getPreviousBerlinISOWeek,
} from './lib/time.ts';
import { calculateWeekSettlement } from './lib/settlement.ts';
import { AuthScreen } from './components/AuthScreen.tsx';
import { SessionSelectModal } from './components/SessionSelectModal.tsx';
import { TopNavbar, BottomNavbar, ActiveTab } from './components/Navbar.tsx';
import { ThisWeekView } from './components/ThisWeekView.tsx';
import { DebtsView } from './components/DebtsView.tsx';
import { HistoryStatsView } from './components/HistoryStatsView.tsx';
import { SessionSettingsView } from './components/SessionSettingsView.tsx';
import { ToastContainer, ToastMessage } from './components/Toast.tsx';
import { Loader2, AlertTriangle, Dumbbell } from 'lucide-react';

export default function App() {
  // Polyfill initialization
  useEffect(() => {
    initWindowStoragePolyfill();
  }, []);

  // Global Auth state
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [usernameLower, setUsernameLower] = useState<string>('');
  const [prefillJoinCode, setPrefillJoinCode] = useState<string | undefined>(undefined);

  // Active Session state
  const [userSessions, setUserSessions] = useState<SessionMeta[]>([]);
  const [currentSession, setCurrentSession] = useState<SessionMeta | null>(null);
  const [showSessionModal, setShowSessionModal] = useState<boolean>(false);

  // Active Tab
  const [currentTab, setCurrentTab] = useState<ActiveTab>('week');

  // Week Data
  const currentWeekKey = getBerlinISOWeek(new Date());
  const nextWeekKey = getNextBerlinISOWeek(new Date());

  const [myCurrentWeekData, setMyCurrentWeekData] = useState<UserWeekData>({
    goal: 0,
    checks: [],
    penaltyCentsSnapshot: 500,
  });
  const [myNextWeekData, setMyNextWeekData] = useState<UserWeekData | null>(null);
  const [allMembersCurrentWeek, setAllMembersCurrentWeek] = useState<Record<string, UserWeekData>>({});

  // Debts & Settlements
  const [openDebts, setOpenDebts] = useState<DebtItem[]>([]);
  const [paymentHistory, setPaymentHistory] = useState<DebtItem[]>([]);
  const [settlements, setSettlements] = useState<WeekSettlement[]>([]);

  // UI state
  const [isLoadingSession, setIsLoadingSession] = useState<boolean>(false);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = (type: 'error' | 'success' | 'info', text: string, onRetry?: () => void) => {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
    setToasts((prev) => [...prev, { id, type, text, onRetry }]);
    if (type !== 'error') {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
    }
  };

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  // Load user sessions list from storage (thorough scan to ensure zero data loss)
  const loadUserSessions = useCallback(
    async (userLower: string, sessionCodes: string[]): Promise<SessionMeta[]> => {
      const loadedMap = new Map<string, SessionMeta>();

      // 1. Load by explicit session codes from user profile
      for (const code of sessionCodes || []) {
        try {
          const session = await storageGet<SessionMeta>(`session:${code}:meta`);
          if (session && session.code) {
            loadedMap.set(session.code, session);
          }
        } catch (_e) {
          // ignore missing
        }
      }

      // 2. Scan all session keys to discover any session where the user is an active member
      try {
        const allSessionKeys = await storageList('session:');
        const metaKeys = allSessionKeys.filter((k) => k.endsWith(':meta'));
        for (const mKey of metaKeys) {
          const code = mKey.replace('session:', '').replace(':meta', '');
          if (!loadedMap.has(code)) {
            const session = await storageGet<SessionMeta>(mKey);
            if (session && session.code) {
              const isMember = session.members?.some(
                (m) => m.user.toLowerCase() === userLower.toLowerCase() && m.active
              );
              if (isMember) {
                loadedMap.set(session.code, session);
              }
            }
          }
        }
      } catch (_e) {
        // ignore scan errors
      }

      return Array.from(loadedMap.values());
    },
    []
  );

  // Automatic Idempotent Settlement for Past Weeks (Section 6.3 & 7.2)
  const checkAndRunPastSettlements = useCallback(
    async (session: SessionMeta) => {
      const code = session.code;
      // List all existing week keys stored for this session
      const weekPrefix = `session:${code}:week:`;
      const allWeekKeys = await storageList(weekPrefix);

      // Extract unique past week identifiers (e.g., "2026-W11") that are strictly before currentWeekKey
      const pastWeeksSet = new Set<string>();
      for (const k of allWeekKeys) {
        const parts = k.replace(weekPrefix, '').split(':');
        const weekKey = parts[0];
        if (weekKey && weekKey < currentWeekKey) {
          pastWeeksSet.add(weekKey);
        }
      }

      // Check also the immediate previous week if not present
      const prevWeek = getPreviousBerlinISOWeek(currentWeekKey);
      pastWeeksSet.add(prevWeek);

      // Load debts storage
      let debtsStore = (await storageGet<DebtsStorage>(`session:${code}:debts`)) || {
        open: [],
        history: [],
      };

      let hasNewSettlements = false;

      for (const pastWeek of Array.from(pastWeeksSet).sort()) {
        const settlementKey = `session:${code}:week:${pastWeek}:settlement`;
        const existingSettlement = await storageGet<WeekSettlement>(settlementKey);

        if (existingSettlement && existingSettlement.settledAt) {
          // Already settled idempotently
          continue;
        }

        // Freshly load all member week data for that past week
        const memberInputs = [];
        for (const member of session.members) {
          const mLower = member.user.toLowerCase();
          const userWeekKey = `session:${code}:week:${pastWeek}:user:${mLower}`;
          const uData = await storageGet<UserWeekData>(userWeekKey);

          memberInputs.push({
            user: mLower,
            displayName: member.displayName,
            goal: uData ? uData.goal : 0,
            completed: uData ? uData.checks?.length || 0 : 0,
            penaltyCents: uData?.penaltyCentsSnapshot || member.penaltyCents,
            joinedMidWeek: uData?.joinedMidWeek || false,
          });
        }

        // Calculate deterministic settlement
        const settlement = calculateWeekSettlement(pastWeek, memberInputs);
        await storageSet(settlementKey, settlement);
        hasNewSettlements = true;

        // Generate open debt items from new settlement entries
        for (const entry of settlement.entries) {
          const newDebtItem: DebtItem = {
            id: `debt-${code}-${pastWeek}-${entry.from}-${entry.to}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
            from: entry.from,
            to: entry.to,
            amountCents: entry.amountCents,
            weekKey: pastWeek,
            status: 'open',
            createdAt: new Date().toISOString(),
          };
          debtsStore.open.push(newDebtItem);
        }
      }

      if (hasNewSettlements) {
        await storageSet(`session:${code}:debts`, debtsStore);
      }
    },
    [currentWeekKey]
  );

  // Freshly load all data for the active session (Section 2.3)
  const refreshSessionData = useCallback(
    async (session: SessionMeta, userLower: string) => {
      setIsRefreshing(true);
      const code = session.code;

      try {
        // 1. Freshly read session meta
        const freshSession = (await storageGet<SessionMeta>(`session:${code}:meta`)) || session;
        setCurrentSession(freshSession);

        // 2. Check and run any pending past week settlements
        await checkAndRunPastSettlements(freshSession);

        // 3. Freshly read all members' data for the current week
        const membersMap: Record<string, UserWeekData> = {};
        for (const member of freshSession.members) {
          const mLower = member.user.toLowerCase();
          const mKey = `session:${code}:week:${currentWeekKey}:user:${mLower}`;
          const mData = await storageGet<UserWeekData>(mKey);

          if (mData) {
            membersMap[mLower] = mData;
          } else {
            // No goal set yet for this week -> spec 6.1/11: never defaults to a
            // nonzero value, always 0 ("pausiert") until the member explicitly plans.
            membersMap[mLower] = {
              goal: 0,
              checks: [],
              penaltyCentsSnapshot: member.penaltyCents,
            };
          }
        }
        setAllMembersCurrentWeek(membersMap);

        // Set my current week data
        const myData = membersMap[userLower] || {
          goal: 0,
          checks: [],
          penaltyCentsSnapshot:
            freshSession.members.find((m) => m.user.toLowerCase() === userLower)?.penaltyCents || 500,
        };
        setMyCurrentWeekData(myData);

        // 4. Read my next week data if planned
        const nextWeekDataKey = `session:${code}:week:${nextWeekKey}:user:${userLower}`;
        const nextData = await storageGet<UserWeekData>(nextWeekDataKey);
        setMyNextWeekData(nextData);

        // 5. Read debts and settlements
        const debtsStore = await storageGet<DebtsStorage>(`session:${code}:debts`);
        setOpenDebts(debtsStore?.open || []);
        setPaymentHistory(debtsStore?.history || []);

        // 6. Read all past settlements for history
        const allKeys = await storageList(`session:${code}:week:`);
        const settlementKeys = allKeys.filter((k) => k.endsWith(':settlement'));
        const loadedSettlements: WeekSettlement[] = [];

        for (const sKey of settlementKeys) {
          const s = await storageGet<WeekSettlement>(sKey);
          if (s) loadedSettlements.push(s);
        }
        setSettlements(loadedSettlements);
      } catch (err: any) {
        addToast(
          'error',
          'Konnte Session-Daten nicht vollständig laden.',
          () => refreshSessionData(session, userLower)
        );
      } finally {
        setIsRefreshing(false);
      }
    },
    [currentWeekKey, nextWeekKey, checkAndRunPastSettlements]
  );

  // Login handler
  const handleLoginSuccess = async (
    profile: UserProfile,
    userLower: string,
    prefillCode?: string
  ) => {
    setCurrentUser(profile);
    setUsernameLower(userLower);
    setPrefillJoinCode(prefillCode);

    setIsLoadingSession(true);
    try {
      const sessions = await loadUserSessions(userLower, profile.sessions || []);
      setUserSessions(sessions);

      if (prefillCode) {
        // User clicked invite link
        const targetSession = await storageGet<SessionMeta>(`session:${prefillCode}:meta`);
        if (targetSession) {
          setShowSessionModal(true);
        } else if (sessions.length > 0) {
          setCurrentSession(sessions[0]);
          await refreshSessionData(sessions[0], userLower);
        } else {
          setShowSessionModal(true);
        }
      } else if (sessions.length > 0) {
        setCurrentSession(sessions[0]);
        await refreshSessionData(sessions[0], userLower);
      } else {
        // No sessions yet -> prompt create or join
        setShowSessionModal(true);
      }
    } catch (e: any) {
      addToast('error', 'Fehler beim Laden der Gruppen: ' + e?.message);
    } finally {
      setIsLoadingSession(false);
    }
  };

  // Update my week data
  const handleUpdateMyWeekData = async (weekKey: string, updated: UserWeekData) => {
    if (!currentSession || !usernameLower) return;
    const storageKey = `session:${currentSession.code}:week:${weekKey}:user:${usernameLower}`;

    try {
      await storageSet(storageKey, updated);

      if (weekKey === currentWeekKey) {
        setMyCurrentWeekData(updated);
        setAllMembersCurrentWeek((prev) => ({
          ...prev,
          [usernameLower]: updated,
        }));
      } else if (weekKey === nextWeekKey) {
        setMyNextWeekData(updated);
      }
    } catch (err: any) {
      addToast('error', 'Konnte nicht gespeichert werden, bitte erneut versuchen.', () =>
        handleUpdateMyWeekData(weekKey, updated)
      );
      throw err;
    }
  };

  // Update debts state
  const handleUpdateDebts = async (updatedOpen: DebtItem[], updatedHistory: DebtItem[]) => {
    if (!currentSession) return;
    const store: DebtsStorage = {
      open: updatedOpen,
      history: updatedHistory,
    };

    try {
      await storageSet(`session:${currentSession.code}:debts`, store);
      setOpenDebts(updatedOpen);
      setPaymentHistory(updatedHistory);
    } catch (err: any) {
      addToast('error', 'Konnte Schuldenstand nicht speichern.');
      throw err;
    }
  };

  // Update session metadata
  const handleUpdateSessionMeta = async (updated: SessionMeta) => {
    try {
      await storageSet(`session:${updated.code}:meta`, updated);
      setCurrentSession(updated);
      setUserSessions((prev) => prev.map((s) => (s.code === updated.code ? updated : s)));
    } catch (err: any) {
      addToast('error', 'Konnte Session-Einstellungen nicht speichern.');
      throw err;
    }
  };

  // Leave session
  const handleLeaveSession = async () => {
    if (!currentSession || !currentUser || !usernameLower) return;
    const code = currentSession.code;

    try {
      const activeMembers = currentSession.members.filter((m) => m.active && m.user.toLowerCase() !== usernameLower);

      if (activeMembers.length === 0) {
        // No members left -> delete session
        await storageDelete(`session:${code}:meta`);
      } else {
        // Pass admin if needed
        let newAdmin = currentSession.adminUser;
        if (currentSession.adminUser.toLowerCase() === usernameLower) {
          newAdmin = activeMembers[0].user;
        }

        const updatedMembers = currentSession.members.map((m) => {
          if (m.user.toLowerCase() === usernameLower) return { ...m, active: false };
          return m;
        });

        const updatedSession: SessionMeta = {
          ...currentSession,
          adminUser: newAdmin,
          members: updatedMembers,
        };
        await storageSet(`session:${code}:meta`, updatedSession);
      }

      // Remove from user's sessions list
      const updatedUserSessions = (currentUser.sessions || []).filter((c) => c !== code);
      const updatedProfile: UserProfile = {
        ...currentUser,
        sessions: updatedUserSessions,
      };
      await storageSet(`user:${usernameLower}`, updatedProfile);
      setCurrentUser(updatedProfile);

      const remainingSessions = userSessions.filter((s) => s.code !== code);
      setUserSessions(remainingSessions);

      if (remainingSessions.length > 0) {
        setCurrentSession(remainingSessions[0]);
        await refreshSessionData(remainingSessions[0], usernameLower);
      } else {
        setCurrentSession(null);
        setShowSessionModal(true);
      }

      addToast('success', 'Session erfolgreich verlassen.');
    } catch (err: any) {
      addToast('error', 'Fehler beim Verlassen der Session: ' + err?.message);
    }
  };

  // Delete session
  const handleDeleteSession = async () => {
    if (!currentSession || !currentUser || !usernameLower) return;
    const code = currentSession.code;

    try {
      await storageDelete(`session:${code}:meta`);
      const updatedUserSessions = (currentUser.sessions || []).filter((c) => c !== code);
      const updatedProfile: UserProfile = {
        ...currentUser,
        sessions: updatedUserSessions,
      };
      await storageSet(`user:${usernameLower}`, updatedProfile);
      setCurrentUser(updatedProfile);

      const remainingSessions = userSessions.filter((s) => s.code !== code);
      setUserSessions(remainingSessions);

      if (remainingSessions.length > 0) {
        setCurrentSession(remainingSessions[0]);
        await refreshSessionData(remainingSessions[0], usernameLower);
      } else {
        setCurrentSession(null);
        setShowSessionModal(true);
      }

      addToast('success', `Session „${currentSession.name}“ wurde gelöscht.`);
    } catch (err: any) {
      addToast('error', 'Fehler beim Löschen der Session.');
    }
  };

  // Manual / Anytime Kassenabschluss (Abrechnung durchführen)
  const handleRunKassenabschluss = async (targetWeekKey?: string): Promise<WeekSettlement> => {
    if (!currentSession) throw new Error('Keine aktive Gruppe.');
    const code = currentSession.code;
    const weekKey = targetWeekKey || currentWeekKey;

    // Load member week inputs
    const memberInputs = [];
    for (const member of currentSession.members) {
      if (!member.active) continue;
      const mLower = member.user.toLowerCase();
      const userWeekKey = `session:${code}:week:${weekKey}:user:${mLower}`;
      const uData = await storageGet<UserWeekData>(userWeekKey);

      memberInputs.push({
        user: mLower,
        displayName: member.displayName,
        goal: uData ? uData.goal : (weekKey === currentWeekKey ? (allMembersCurrentWeek[mLower]?.goal ?? 0) : 0),
        completed: uData ? (uData.checks?.length || 0) : (weekKey === currentWeekKey ? (allMembersCurrentWeek[mLower]?.checks?.length || 0) : 0),
        penaltyCents: uData?.penaltyCentsSnapshot || member.penaltyCents,
        joinedMidWeek: uData?.joinedMidWeek || false,
      });
    }

    const settlement = calculateWeekSettlement(weekKey, memberInputs);
    const settlementKey = `session:${code}:week:${weekKey}:settlement`;
    await storageSet(settlementKey, settlement);

    // Update debts
    let debtsStore = (await storageGet<DebtsStorage>(`session:${code}:debts`)) || {
      open: [],
      history: [],
    };

    // Remove any previously generated open items for this week to prevent duplicates if re-settled
    const filteredOpen = debtsStore.open.filter((d) => d.weekKey !== weekKey);

    for (const entry of settlement.entries) {
      const newDebtItem: DebtItem = {
        id: `debt-${code}-${weekKey}-${entry.from}-${entry.to}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        from: entry.from,
        to: entry.to,
        amountCents: entry.amountCents,
        weekKey: weekKey,
        status: 'open',
        createdAt: new Date().toISOString(),
      };
      filteredOpen.push(newDebtItem);
    }

    const updatedDebtsStore: DebtsStorage = {
      open: filteredOpen,
      history: debtsStore.history,
    };
    await storageSet(`session:${code}:debts`, updatedDebtsStore);

    setOpenDebts(filteredOpen);
    setSettlements((prev) => [settlement, ...prev.filter((s) => s.weekKey !== weekKey)]);

    addToast('success', `Kassenabschluss für KW ${weekKey.replace('2026-W', '')} erfolgreich verbucht!`);
    await refreshSessionData(currentSession, usernameLower);
    return settlement;
  };

  // Direct Payment / Anytime Settlement (Jederzeit direkt zahlen & ausgleichen)
  const handleRecordDirectPayment = async (
    fromUser: string,
    toUser: string,
    amountCents: number,
    _memo?: string
  ) => {
    if (!currentSession) return;
    const code = currentSession.code;
    const fromLower = fromUser.toLowerCase();
    const toLower = toUser.toLowerCase();

    let debtsStore = (await storageGet<DebtsStorage>(`session:${code}:debts`)) || {
      open: [],
      history: [],
    };

    let remainingToPay = amountCents;
    const updatedOpen: DebtItem[] = [];

    // First, offset matching open debts where fromLower owes toLower
    for (const item of debtsStore.open) {
      if (
        item.status !== 'paid' &&
        item.from.toLowerCase() === fromLower &&
        item.to.toLowerCase() === toLower &&
        remainingToPay > 0
      ) {
        if (remainingToPay >= item.amountCents) {
          // Fully pay this item
          remainingToPay -= item.amountCents;
          debtsStore.history.unshift({
            ...item,
            status: 'paid',
            paidAt: new Date().toISOString(),
          });
        } else {
          // Partially pay this item
          const paidPart: DebtItem = {
            id: `${item.id}-part-${Date.now()}`,
            from: item.from,
            to: item.to,
            amountCents: remainingToPay,
            weekKey: item.weekKey,
            status: 'paid',
            createdAt: item.createdAt,
            paidAt: new Date().toISOString(),
          };
          debtsStore.history.unshift(paidPart);

          updatedOpen.push({
            ...item,
            amountCents: item.amountCents - remainingToPay,
            status: 'open',
          });
          remainingToPay = 0;
        }
      } else {
        updatedOpen.push(item);
      }
    }

    // If there is still extra paid or no open debt existed, record as a direct settled payment
    if (remainingToPay > 0 || (amountCents > 0 && debtsStore.open.length === updatedOpen.length)) {
      debtsStore.history.unshift({
        id: `direct-pay-${code}-${fromLower}-${toLower}-${Date.now()}`,
        from: fromLower,
        to: toLower,
        amountCents: remainingToPay > 0 ? remainingToPay : amountCents,
        weekKey: currentWeekKey,
        status: 'paid',
        createdAt: new Date().toISOString(),
        paidAt: new Date().toISOString(),
      });
    }

    const finalStore: DebtsStorage = {
      open: updatedOpen,
      history: debtsStore.history,
    };

    await storageSet(`session:${code}:debts`, finalStore);
    setOpenDebts(updatedOpen);
    setPaymentHistory(debtsStore.history);
  };

  // Helper to seed Section 7.4 Demo Group
  const handleSeedDemoGroup = async () => {
    if (!currentUser || !usernameLower) return;
    const demoCode = 'DEMO74';
    const aliMember = { user: 'ali', displayName: 'Ali', joinedAt: new Date().toISOString(), penaltyCents: 500, active: true };
    const beaMember = { user: 'bea', displayName: 'Bea', joinedAt: new Date().toISOString(), penaltyCents: 1000, active: true };
    const cemMember = { user: 'cem', displayName: 'Cem', joinedAt: new Date().toISOString(), penaltyCents: 500, active: true };

    const demoSession: SessionMeta = {
      code: demoCode,
      name: 'Gym Beasts (7.4 Demo)',
      createdAt: new Date().toISOString(),
      adminUser: 'ali',
      members: [aliMember, beaMember, cemMember],
      settings: { allowMultiplePerDay: false },
    };

    await storageSet(`session:${demoCode}:meta`, demoSession);

    // Seed previous week data: Ali (3/3), Bea (0/2), Cem (3/4)
    const prevWeek = getPreviousBerlinISOWeek(currentWeekKey);
    await storageSet(`session:${demoCode}:week:${prevWeek}:user:ali`, {
      goal: 3,
      checks: [{ timestamp: new Date().toISOString() }, { timestamp: new Date().toISOString() }, { timestamp: new Date().toISOString() }],
      penaltyCentsSnapshot: 500,
    });
    await storageSet(`session:${demoCode}:week:${prevWeek}:user:bea`, {
      goal: 2,
      checks: [],
      penaltyCentsSnapshot: 1000,
    });
    await storageSet(`session:${demoCode}:week:${prevWeek}:user:cem`, {
      goal: 4,
      checks: [{ timestamp: new Date().toISOString() }, { timestamp: new Date().toISOString() }, { timestamp: new Date().toISOString() }],
      penaltyCentsSnapshot: 500,
    });

    // Add to user sessions
    const updated = Array.from(new Set([...(currentUser.sessions || []), demoCode]));
    await storageSet(`user:${usernameLower}`, { ...currentUser, sessions: updated });

    setCurrentSession(demoSession);
    setUserSessions((prev) => [...prev.filter((s) => s.code !== demoCode), demoSession]);
    await refreshSessionData(demoSession, usernameLower);
    addToast('success', '7.4 Demo-Gruppe mit Ali, Bea & Cem geladen!');
  };

  // Not logged in -> Show Auth Screen
  if (!currentUser || !usernameLower) {
    return (
      <>
        <AuthScreen
          onLoginSuccess={handleLoginSuccess}
          onError={(msg) => addToast('error', msg)}
        />
        <ToastContainer toasts={toasts} onDismiss={removeToast} />
      </>
    );
  }

  // Loading state
  if (isLoadingSession) {
    return (
      <div className="min-h-screen bg-[#0A0A0A] flex flex-col items-center justify-center p-4 text-white">
        <Loader2 className="w-10 h-10 text-[#DFFF00] animate-spin mb-3 stroke-[2.5]" />
        <p className="text-xs font-black uppercase tracking-widest text-white/60">Lade Trainingsgruppen...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-white flex flex-col justify-between selection:bg-[#DFFF00] selection:text-black font-sans">
      {/* Top Navbar */}
      {currentSession && (
        <TopNavbar
          currentTab={currentTab}
          onSelectTab={setCurrentTab}
          session={currentSession}
          currentUser={currentUser}
          onRefresh={() => refreshSessionData(currentSession, usernameLower)}
          isRefreshing={isRefreshing}
          onSwitchSession={() => setShowSessionModal(true)}
          openDebtsCount={openDebts.filter((d) => d.status !== 'paid').length}
        />
      )}

      {/* Main Content Area */}
      <main className="flex-1 max-w-md w-full mx-auto p-4 pt-4 sm:pt-6">
        {!currentSession ? (
          <div className="py-16 text-center flex flex-col items-center gap-3">
            <div className="w-16 h-16 rounded-3xl bg-[#DFFF00] text-black flex items-center justify-center mb-2 shadow-xl shadow-[#DFFF00]/10">
              <Dumbbell className="w-8 h-8 stroke-[2.5]" />
            </div>
            <h2 className="text-2xl font-black uppercase tracking-tight text-white">Keine aktive Session ausgewählt</h2>
            <p className="text-xs uppercase tracking-wider text-white/50 max-w-xs font-bold leading-relaxed">
              Tritt einer Session bei oder erstelle eine neue Gruppe mit deinen Freunden.
            </p>
            <button
              type="button"
              id="open-session-select-btn"
              onClick={() => setShowSessionModal(true)}
              className="mt-4 px-6 py-3.5 bg-[#DFFF00] hover:scale-[1.02] active:scale-95 text-black font-black uppercase tracking-wider text-xs rounded-2xl shadow-xl cursor-pointer"
            >
              Session auswählen / beitreten
            </button>
          </div>
        ) : (
          <>
            {currentTab === 'week' && (
              <ThisWeekView
                currentWeekKey={currentWeekKey}
                nextWeekKey={nextWeekKey}
                session={currentSession}
                currentUser={currentUser}
                usernameLower={usernameLower}
                myCurrentWeekData={myCurrentWeekData}
                myNextWeekData={myNextWeekData}
                allMembersCurrentWeek={allMembersCurrentWeek}
                onUpdateMyWeekData={handleUpdateMyWeekData}
                onError={(msg) => addToast('error', msg)}
                onSuccess={(msg) => addToast('success', msg)}
              />
            )}

            {currentTab === 'debts' && (
              <DebtsView
                session={currentSession}
                currentUser={currentUser}
                usernameLower={usernameLower}
                openDebts={openDebts}
                paymentHistory={paymentHistory}
                currentWeekKey={currentWeekKey}
                allMembersCurrentWeek={allMembersCurrentWeek}
                onUpdateDebts={handleUpdateDebts}
                onRunKassenabschluss={handleRunKassenabschluss}
                onRecordDirectPayment={handleRecordDirectPayment}
                onError={(msg) => addToast('error', msg)}
                onSuccess={(msg) => addToast('success', msg)}
              />
            )}

            {currentTab === 'history' && (
              <HistoryStatsView
                session={currentSession}
                currentUser={currentUser}
                usernameLower={usernameLower}
                settlements={settlements}
              />
            )}

            {currentTab === 'settings' && (
              <SessionSettingsView
                session={currentSession}
                currentUser={currentUser}
                usernameLower={usernameLower}
                openDebts={openDebts}
                onUpdateSessionMeta={handleUpdateSessionMeta}
                onRunKassenabschluss={handleRunKassenabschluss}
                onLeaveSession={handleLeaveSession}
                onDeleteSession={handleDeleteSession}
                onSwitchSession={() => setShowSessionModal(true)}
                onError={(msg) => addToast('error', msg)}
                onSuccess={(msg) => addToast('success', msg)}
                onSeedDemoGroup={handleSeedDemoGroup}
              />
            )}
          </>
        )}
      </main>

      {/* Bottom Tab Bar */}
      {currentSession && (
        <BottomNavbar
          currentTab={currentTab}
          onSelectTab={setCurrentTab}
          session={currentSession}
          currentUser={currentUser}
          onRefresh={() => refreshSessionData(currentSession, usernameLower)}
          isRefreshing={isRefreshing}
          onSwitchSession={() => setShowSessionModal(true)}
          openDebtsCount={openDebts.filter((d) => d.status !== 'paid').length}
        />
      )}

      {/* Session Select / Join / Create Modal */}
      {showSessionModal && (
        <SessionSelectModal
          currentUser={currentUser}
          usernameLower={usernameLower}
          sessions={userSessions}
          currentSessionCode={currentSession?.code || null}
          prefillCode={prefillJoinCode}
          onSelectSession={(s) => {
            setCurrentSession(s);
            setShowSessionModal(false);
            refreshSessionData(s, usernameLower);
          }}
          onSessionCreatedOrJoined={(s) => {
            setCurrentSession(s);
            setUserSessions((prev) => [s, ...prev.filter((p) => p.code !== s.code)]);
            setShowSessionModal(false);
            refreshSessionData(s, usernameLower);
            addToast('success', `Session „${s.name}“ geöffnet!`);
          }}
          onError={(msg) => addToast('error', msg)}
          onLogout={() => {
            setCurrentUser(null);
            setUsernameLower('');
            setCurrentSession(null);
            setShowSessionModal(false);
          }}
        />
      )}

      {/* Toast Notifications */}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </div>
  );
}
