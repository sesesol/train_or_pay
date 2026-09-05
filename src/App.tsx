/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  UserProfile,
  SessionMeta,
  UserWeekData,
  WeekSettlement,
  DebtItem,
  DebtsStorage,
  ExceptionRequest,
} from './types.ts';
import {
  storageGet,
  storageSet,
  storageList,
  storageGetMany,
  storageDelete,
  initWindowStoragePolyfill,
} from './lib/storage.ts';
import {
  ensureUserId,
  saveLoginSession,
  readLoginSession,
  clearLoginSession,
} from './lib/session.ts';
import {
  loadWeekExceptions,
  computeExcusedFor,
  buildExcusedMap,
  countActiveExceptions,
  hasActiveWeekException,
  nextSlotForUser,
  exceptionKey,
} from './lib/exceptions.ts';
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

  // Attempt to restore a persisted login session on startup. The persisted
  // record is only a pointer (user_id + username); the actual account is always
  // re-loaded fresh from the database, which remains the source of truth.
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      const record = readLoginSession();
      if (!record) {
        if (!cancelled) setIsRestoringSession(false);
        return;
      }

      try {
        const dbProfile = await storageGet<UserProfile>(`user:${record.usernameLower}`);

        // Only auto-login if the account still exists AND matches the stored
        // permanent id (guards against a reused/renamed username on the server).
        if (dbProfile && (!dbProfile.id || dbProfile.id === record.userId)) {
          if (cancelled) return;
          // Parse a possible ?join=CODE / #join=CODE invite so it still works.
          let prefill: string | undefined;
          try {
            const src = `${window.location.hash} ${window.location.search}`;
            const match = src.match(/join=([A-Za-z0-9]+)/);
            if (match && match[1]) prefill = match[1].toUpperCase();
          } catch (_e) {
            // ignore
          }
          setIsRestoringSession(false);
          await handleLoginSuccess(dbProfile, record.usernameLower, prefill);
          return;
        }

        // Stored session no longer valid -> drop it, fall back to manual login.
        clearLoginSession();
      } catch (_e) {
        // Could not reach the database; leave the pointer in place and let the
        // user log in manually (no data is lost either way).
      }
      if (!cancelled) setIsRestoringSession(false);
    };

    restore();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Exception ("Ausnahme") requests for the current week of the active session
  const [weekExceptions, setWeekExceptions] = useState<ExceptionRequest[]>([]);

  // Refs used for reliable auto-sync without clobbering in-flight local edits.
  const refreshRef = useRef<((s: SessionMeta, u: string, silent?: boolean) => Promise<void>) | null>(null);
  const pendingMyWriteRef = useRef<number>(0);
  const myWeekDataRef = useRef<UserWeekData | null>(null);

  // Debts & Settlements
  const [openDebts, setOpenDebts] = useState<DebtItem[]>([]);
  const [paymentHistory, setPaymentHistory] = useState<DebtItem[]>([]);
  const [settlements, setSettlements] = useState<WeekSettlement[]>([]);

  // UI state
  const [isLoadingSession, setIsLoadingSession] = useState<boolean>(false);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isRestoringSession, setIsRestoringSession] = useState<boolean>(true);
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

      // 2. Discover any other session where the user is an active member.
      //    Performance: one batch read of all session meta records instead of a
      //    separate request per session.
      try {
        const metas = await storageGetMany('session:', ':meta');
        for (const [key, session] of Object.entries(metas)) {
          if (!key.endsWith(':meta')) continue;
          const meta = session as SessionMeta;
          if (!meta || !meta.code || loadedMap.has(meta.code)) continue;
          const isMember = meta.members?.some(
            (m) => m.user.toLowerCase() === userLower.toLowerCase() && m.active
          );
          if (isMember) loadedMap.set(meta.code, meta);
        }
      } catch (_e) {
        // ignore scan errors
      }

      return Array.from(loadedMap.values());
    },
    []
  );

  // Automatic Idempotent Settlement for Past Weeks (Section 6.3 & 7.2).
  // Works entirely off an already-loaded snapshot of the session subtree, so it
  // performs no extra reads. New settlements are written back into `all` so the
  // caller can derive state from a single, consistent snapshot.
  const checkAndRunPastSettlements = useCallback(
    async (session: SessionMeta, all: Record<string, any>) => {
      const code = session.code;
      const weekPrefix = `session:${code}:week:`;

      // Unique past week identifiers strictly before the current week.
      const pastWeeksSet = new Set<string>();
      for (const k of Object.keys(all)) {
        if (!k.startsWith(weekPrefix)) continue;
        const weekKey = k.slice(weekPrefix.length).split(':')[0];
        if (weekKey && weekKey < currentWeekKey) pastWeeksSet.add(weekKey);
      }
      pastWeeksSet.add(getPreviousBerlinISOWeek(currentWeekKey));

      const debtsStore: DebtsStorage = all[`session:${code}:debts`] || { open: [], history: [] };
      let hasNewSettlements = false;

      for (const pastWeek of Array.from(pastWeeksSet).sort()) {
        const settlementKey = `${weekPrefix}${pastWeek}:settlement`;
        const existingSettlement = all[settlementKey] as WeekSettlement | undefined;
        if (existingSettlement && existingSettlement.settledAt) continue; // already settled

        // Exceptions of that past week, straight from the snapshot.
        const excPrefix = `${weekPrefix}${pastWeek}:exception:`;
        const pastExceptions: ExceptionRequest[] = Object.keys(all)
          .filter((k) => k.startsWith(excPrefix))
          .map((k) => all[k])
          .filter((e) => e && e.id);

        const memberInputs = session.members.map((member) => {
          const mLower = member.user.toLowerCase();
          const uData = all[`${weekPrefix}${pastWeek}:user:${mLower}`] as UserWeekData | undefined;
          const goal = uData ? uData.goal : 0;
          const completed = uData ? uData.checks?.length || 0 : 0;
          return {
            user: mLower,
            displayName: member.displayName,
            goal,
            completed,
            penaltyCents: uData?.penaltyCentsSnapshot || member.penaltyCents,
            joinedMidWeek: uData?.joinedMidWeek || false,
            excused: computeExcusedFor(pastExceptions, mLower, goal, completed),
          };
        });

        const settlement = calculateWeekSettlement(pastWeek, memberInputs);
        await storageSet(settlementKey, settlement);
        all[settlementKey] = settlement;
        hasNewSettlements = true;

        for (const entry of settlement.entries) {
          debtsStore.open.push({
            id: `debt-${code}-${pastWeek}-${entry.from}-${entry.to}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
            from: entry.from,
            to: entry.to,
            amountCents: entry.amountCents,
            weekKey: pastWeek,
            status: 'open',
            createdAt: new Date().toISOString(),
          });
        }
      }

      if (hasNewSettlements) {
        await storageSet(`session:${code}:debts`, debtsStore);
        all[`session:${code}:debts`] = debtsStore;
      }
    },
    [currentWeekKey]
  );

  // Freshly load all data for the active session.
  // Performance: the entire session subtree is fetched in ONE batch request and
  // everything below is derived locally (previously dozens of sequential round
  // trips per refresh, repeated by every poll).
  // `silent` is used by background auto-sync so it doesn't flash the spinner or
  // raise error toasts on transient network blips.
  const refreshSessionData = useCallback(
    async (session: SessionMeta, userLower: string, silent = false) => {
      if (!silent) setIsRefreshing(true);
      const code = session.code;

      try {
        // 1. One batch read of the whole session subtree.
        const all = await storageGetMany(`session:${code}:`);

        const freshSession = (all[`session:${code}:meta`] as SessionMeta) || session;
        setCurrentSession(freshSession);

        // 2. Settle finished past weeks. This must never block the rest of the
        //    refresh: a failure here previously aborted the whole function, so
        //    members' progress was never displayed. It is idempotent and only
        //    needed on explicit refreshes, not on every background poll.
        if (!silent) {
          try {
            await checkAndRunPastSettlements(freshSession, all);
          } catch (settleErr) {
            console.warn('Past-week settlement skipped:', settleErr);
          }
        }

        // 3. All members' data for the current week (from the snapshot).
        const membersMap: Record<string, UserWeekData> = {};
        for (const member of freshSession.members) {
          const mLower = member.user.toLowerCase();
          const mData = all[`session:${code}:week:${currentWeekKey}:user:${mLower}`] as
            | UserWeekData
            | undefined;
          // No goal set yet for this week -> spec 6.1/11: never defaults to a
          // nonzero value, always 0 ("pausiert") until the member explicitly plans.
          membersMap[mLower] = mData || {
            goal: 0,
            checks: [],
            penaltyCentsSnapshot: member.penaltyCents,
          };
        }

        // If the current user has a write in flight (e.g. just tapped a circle),
        // keep the local copy of THEIR data so a concurrent auto-sync refresh can
        // never roll back their own edit. Other members' data is always taken
        // fresh from the database.
        if (pendingMyWriteRef.current > 0 && myWeekDataRef.current) {
          membersMap[userLower] = myWeekDataRef.current;
        }
        setAllMembersCurrentWeek(membersMap);

        const myData = membersMap[userLower] || {
          goal: 0,
          checks: [],
          penaltyCentsSnapshot:
            freshSession.members.find((m) => m.user.toLowerCase() === userLower)?.penaltyCents || 500,
        };
        setMyCurrentWeekData(myData);
        myWeekDataRef.current = myData;

        // 3b. Shared exception requests for the current week (both partners).
        const excPrefix = `session:${code}:week:${currentWeekKey}:exception:`;
        const exceptions: ExceptionRequest[] = Object.keys(all)
          .filter((k) => k.startsWith(excPrefix))
          .map((k) => all[k])
          .filter((e) => e && e.id)
          .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
        setWeekExceptions(exceptions);

        // 4. My next week plan
        setMyNextWeekData(
          (all[`session:${code}:week:${nextWeekKey}:user:${userLower}`] as UserWeekData) || null
        );

        // 5. Debts
        const debtsStore = all[`session:${code}:debts`] as DebtsStorage | undefined;
        setOpenDebts(debtsStore?.open || []);
        setPaymentHistory(debtsStore?.history || []);

        // 6. All past settlements for history
        const loadedSettlements: WeekSettlement[] = Object.keys(all)
          .filter((k) => k.endsWith(':settlement'))
          .map((k) => all[k])
          .filter(Boolean);
        setSettlements(loadedSettlements);
      } catch (err: any) {
        if (!silent) {
          addToast(
            'error',
            'Konnte Session-Daten nicht vollständig laden.',
            () => refreshSessionData(session, userLower)
          );
        }
      } finally {
        if (!silent) setIsRefreshing(false);
      }
    },
    [currentWeekKey, nextWeekKey, checkAndRunPastSettlements]
  );

  // Keep a ref to the latest refresh fn so background auto-sync always calls the
  // current version without needing it in the polling effect's dependencies.
  useEffect(() => {
    refreshRef.current = refreshSessionData;
  });

  // Auto-sync: because this key-value backend has no realtime push, poll the
  // shared session on an interval and whenever the tab regains focus, so each
  // partner reliably sees the other's latest checks and exception decisions.
  useEffect(() => {
    if (!currentSession || !usernameLower) return;
    const doSync = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const fn = refreshRef.current;
      if (fn) fn(currentSession, usernameLower, true).catch(() => {});
    };
    const interval = window.setInterval(doSync, 15000);
    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) doSync();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', doSync);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', doSync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSession?.code, usernameLower]);

  // Login handler
  const handleLoginSuccess = async (
    profile: UserProfile,
    userLower: string,
    prefillCode?: string
  ) => {
    // Guarantee a permanent user_id. Legacy accounts created before this field
    // existed get one assigned once and persisted back to the database.
    const { profile: ensuredProfile, changed } = ensureUserId(profile);
    if (changed) {
      try {
        await storageSet(`user:${userLower}`, ensuredProfile);
      } catch (_e) {
        // Non-fatal: keep the id in memory for this session; retried next login.
      }
    }

    setCurrentUser(ensuredProfile);
    setUsernameLower(userLower);
    setPrefillJoinCode(prefillCode);

    // Persist a supporting login-session pointer on this device so a returning
    // user is auto-recognised. The database stays the source of truth.
    saveLoginSession(ensuredProfile, userLower);

    setIsLoadingSession(true);
    try {
      const sessions = await loadUserSessions(userLower, ensuredProfile.sessions || []);
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

    // Optimistically reflect the edit and mark a write in flight so a concurrent
    // auto-sync refresh keeps this local copy instead of rolling it back.
    if (weekKey === currentWeekKey) {
      myWeekDataRef.current = updated;
      setMyCurrentWeekData(updated);
      setAllMembersCurrentWeek((prev) => ({ ...prev, [usernameLower]: updated }));
    } else if (weekKey === nextWeekKey) {
      setMyNextWeekData(updated);
    }

    pendingMyWriteRef.current += 1;
    try {
      await storageSet(storageKey, updated);
    } catch (err: any) {
      addToast('error', 'Konnte nicht gespeichert werden, bitte erneut versuchen.', () =>
        handleUpdateMyWeekData(weekKey, updated)
      );
      throw err;
    } finally {
      pendingMyWriteRef.current = Math.max(0, pendingMyWriteRef.current - 1);
    }
  };

  // Request an exception ("Ausnahme") for one open planned unit of the current
  // week. Needs a partner's approval; never affects future weeks.
  const handleRequestException = async (
    reasonCode?: string,
    reasonLabel?: string,
    kind: 'single' | 'week' = 'single'
  ) => {
    if (!currentSession || !usernameLower || !currentUser) return;
    const code = currentSession.code;

    // Permission: only an active member of THIS session may request.
    const me = currentSession.members.find(
      (m) => m.user.toLowerCase() === usernameLower && m.active
    );
    if (!me) {
      addToast('error', 'Nur aktive Mitglieder dieser Gruppe können eine Ausnahme beantragen.');
      return;
    }

    const myData = allMembersCurrentWeek[usernameLower] || myCurrentWeekData;
    const goal = myData?.goal || 0;
    const completed = myData?.checks?.length || 0;
    if (goal <= 0) {
      addToast('info', 'Diese Woche ist pausiert – es gibt keinen Sporttag zum Auslassen.');
      return;
    }

    // There must be another active member who can decide (no self-approval).
    const otherActive = currentSession.members.filter(
      (m) => m.active && m.user.toLowerCase() !== usernameLower
    );
    if (otherActive.length === 0) {
      addToast('error', 'Es gibt kein anderes Mitglied, das die Ausnahme genehmigen könnte.');
      return;
    }

    try {
      // Re-read fresh to avoid races and prevent contradictory/duplicate requests.
      const fresh = await loadWeekExceptions(code, currentWeekKey);

      // An emergency dropout already covers the whole rest of the week, so no
      // further request of either kind may be stacked on top of it.
      if (hasActiveWeekException(fresh, usernameLower)) {
        addToast('info', 'Es läuft bereits ein Notfall-Ausfall für diese Woche.');
        await refreshSessionData(currentSession, usernameLower);
        return;
      }

      if (kind === 'week') {
        // Emergency dropout: needs at least one open unit left to excuse.
        if (goal - completed <= 0) {
          addToast('info', 'Du hast diese Woche bereits alle Einheiten erledigt.');
          await refreshSessionData(currentSession, usernameLower);
          return;
        }
      } else {
        const active = countActiveExceptions(fresh, usernameLower);
        if (goal - completed - active <= 0) {
          addToast('info', 'Für diese Woche sind keine offenen Sporttage mehr zum Auslassen vorhanden.');
          await refreshSessionData(currentSession, usernameLower);
          return;
        }
      }

      const slot = nextSlotForUser(fresh, usernameLower);
      const req: ExceptionRequest = {
        id: `${currentWeekKey}:${usernameLower}:${slot}`,
        sessionCode: code,
        weekKey: currentWeekKey,
        requester: usernameLower,
        requesterId: currentUser.id,
        requesterDisplayName: currentUser.displayName,
        kind,
        slot,
        reasonCode,
        reasonLabel,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      await storageSet(exceptionKey(code, currentWeekKey, usernameLower, slot), req);
      addToast(
        'success',
        kind === 'week'
          ? 'Notfall-Ausfall beantragt. Er wartet auf die Zustimmung deines Partners.'
          : 'Ausnahme-Anfrage gesendet. Sie wartet auf die Zustimmung deines Partners.'
      );
      await refreshSessionData(currentSession, usernameLower);
    } catch (e: any) {
      addToast('error', 'Anfrage konnte nicht gespeichert werden: ' + (e?.message || ''));
    }
  };

  // Approve or reject an exception request. Only a partner (not the requester)
  // of the same session may decide, and only while it is still pending.
  const handleDecideException = async (request: ExceptionRequest, approve: boolean) => {
    if (!currentSession || !usernameLower || !currentUser) return;
    const code = currentSession.code;

    const me = currentSession.members.find(
      (m) => m.user.toLowerCase() === usernameLower && m.active
    );
    if (!me) {
      addToast('error', 'Nur aktive Mitglieder dieser Gruppe können entscheiden.');
      return;
    }
    if (request.sessionCode !== code) {
      addToast('error', 'Diese Anfrage gehört nicht zu dieser Gruppe.');
      return;
    }
    if (request.requester.toLowerCase() === usernameLower) {
      addToast('error', 'Du kannst deine eigene Anfrage nicht selbst bestätigen.');
      return;
    }

    try {
      // Re-read the specific request to avoid acting on stale state / double-decide.
      const key = exceptionKey(code, request.weekKey, request.requester.toLowerCase(), request.slot);
      const freshReq = await storageGet<ExceptionRequest>(key);
      if (!freshReq) {
        addToast('error', 'Diese Anfrage ist nicht mehr vorhanden.');
        await refreshSessionData(currentSession, usernameLower);
        return;
      }
      if (freshReq.status !== 'pending') {
        addToast('info', 'Diese Anfrage wurde bereits entschieden.');
        await refreshSessionData(currentSession, usernameLower);
        return;
      }

      const updated: ExceptionRequest = {
        ...freshReq,
        status: approve ? 'approved' : 'rejected',
        decidedBy: usernameLower,
        decidedByDisplayName: currentUser.displayName,
        decidedAt: new Date().toISOString(),
      };
      await storageSet(key, updated);
      addToast(
        'success',
        approve
          ? freshReq.kind === 'week'
            ? `Notfall-Ausfall für ${freshReq.requesterDisplayName} genehmigt — restliche Woche entschuldigt.`
            : `Ausnahme für ${freshReq.requesterDisplayName} genehmigt (Entschuldigt).`
          : freshReq.kind === 'week'
          ? `Notfall-Ausfall für ${freshReq.requesterDisplayName} abgelehnt.`
          : `Ausnahme für ${freshReq.requesterDisplayName} abgelehnt.`
      );
      await refreshSessionData(currentSession, usernameLower);
    } catch (e: any) {
      addToast('error', 'Entscheidung konnte nicht gespeichert werden: ' + (e?.message || ''));
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

    // Approved exceptions for this week -> excused (penalty-free) units.
    const weekExc = await loadWeekExceptions(code, weekKey);

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
        excused: computeExcusedFor(
          weekExc,
          mLower,
          uData ? uData.goal : (weekKey === currentWeekKey ? (allMembersCurrentWeek[mLower]?.goal ?? 0) : 0),
          uData ? (uData.checks?.length || 0) : (weekKey === currentWeekKey ? (allMembersCurrentWeek[mLower]?.checks?.length || 0) : 0)
        ),
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

  // While restoring a persisted login session, show a loader instead of
  // briefly flashing the login screen.
  if (isRestoringSession && (!currentUser || !usernameLower)) {
    return (
      <div className="min-h-screen bg-[#0A0A0A] flex flex-col items-center justify-center p-4 text-white">
        <Loader2 className="w-10 h-10 text-[#DFFF00] animate-spin mb-3 stroke-[2.5]" />
        <p className="text-xs font-black uppercase tracking-widest text-white/60">Sitzung wird wiederhergestellt...</p>
      </div>
    );
  }

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

  // Derived: current-week excused counts per user + pending requests I must decide.
  const currentWeekExcused = buildExcusedMap(weekExceptions, allMembersCurrentWeek);
  const pendingExceptionsForMe = weekExceptions.filter(
    (e) => e.status === 'pending' && e.requester.toLowerCase() !== usernameLower
  ).length;

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
          weekBadgeCount={pendingExceptionsForMe}
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
                weekExceptions={weekExceptions}
                excusedByUser={currentWeekExcused}
                onUpdateMyWeekData={handleUpdateMyWeekData}
                onRequestException={handleRequestException}
                onDecideException={handleDecideException}
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
                excusedByUser={currentWeekExcused}
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
          weekBadgeCount={pendingExceptionsForMe}
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
            clearLoginSession();
            setCurrentUser(null);
            setUsernameLower('');
            setCurrentSession(null);
            setShowSessionModal(false);
            setUserSessions([]);
          }}
        />
      )}

      {/* Toast Notifications */}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </div>
  );
}
