/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Plus, LogIn, Users, Shield, ArrowRight, AlertTriangle, Sparkles, Check } from 'lucide-react';
import { SessionMeta, SessionMember, UserProfile } from '../types.ts';
import { storageGet, storageSet, storageGetMany } from '../lib/storage.ts';
import { formatEuro } from '../lib/settlement.ts';
import { getBerlinParts, getBerlinISOWeek } from '../lib/time.ts';

interface SessionSelectModalProps {
  currentUser: UserProfile;
  usernameLower: string;
  sessions: SessionMeta[];
  currentSessionCode: string | null;
  prefillCode?: string;
  onSelectSession: (session: SessionMeta) => void;
  onSessionCreatedOrJoined: (session: SessionMeta) => void;
  onError: (msg: string) => void;
  onLogout: () => void;
  onRefreshSessions?: () => Promise<void> | void;
}

// Characters allowed: uppercase letters + digits without 0, O, 1, I, L
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function generateJoinCode(): string {
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  }
  return result;
}

function extractCode(input: string): string {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/join=([A-Za-z0-9]+)/i);
  if (urlMatch && urlMatch[1]) return urlMatch[1].toUpperCase().slice(0, 6);
  const cleaned = trimmed.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return cleaned.slice(0, 6);
}

export const SessionSelectModal: React.FC<SessionSelectModalProps> = ({
  currentUser,
  usernameLower,
  sessions,
  currentSessionCode,
  prefillCode,
  onSelectSession,
  onSessionCreatedOrJoined,
  onError,
  onLogout,
  onRefreshSessions,
}) => {
  const [tab, setTab] = useState<'list' | 'create' | 'join'>(
    prefillCode ? 'join' : sessions.length === 0 ? 'list' : 'list'
  );
  const [sessionName, setSessionName] = useState('');
  const [joinCodeInput, setJoinCodeInput] = useState(prefillCode ? extractCode(prefillCode) : '');
  const [penaltyEuro, setPenaltyEuro] = useState<number>(5.0); // 5.00 € default
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshingList, setIsRefreshingList] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleCreateSession = async () => {
    setErrorMsg(null);
    const cleanName = sessionName.trim();
    if (cleanName.length < 3 || cleanName.length > 40) {
      setErrorMsg('Der Session-Name muss 3 bis 40 Zeichen lang sein.');
      return;
    }

    setIsLoading(true);
    try {
      // Generate unique code with up to 10 attempts
      let code = '';
      let isUnique = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = generateJoinCode();
        const existing = await storageGet<SessionMeta>(`session:${candidate}:meta`);
        if (!existing) {
          code = candidate;
          isUnique = true;
          break;
        }
      }

      if (!isUnique || !code) {
        setErrorMsg('Konnte keinen eindeutigen Code generieren. Bitte erneut versuchen.');
        setIsLoading(false);
        return;
      }

      const penaltyCents = Math.round(penaltyEuro * 100);
      const newMember: SessionMember = {
        user: usernameLower,
        userId: currentUser.id,
        displayName: currentUser.displayName,
        joinedAt: new Date().toISOString(),
        penaltyCents,
        active: true,
      };

      const newSession: SessionMeta = {
        code,
        name: cleanName,
        createdAt: new Date().toISOString(),
        adminUser: usernameLower,
        members: [newMember],
        settings: {
          allowMultiplePerDay: false,
        },
      };

      await storageSet(`session:${code}:meta`, newSession);

      // Add to user sessions list
      const updatedUserSessions = Array.from(new Set([...(currentUser.sessions || []), code]));
      const updatedProfile: UserProfile = {
        ...currentUser,
        sessions: updatedUserSessions,
      };
      await storageSet(`user:${usernameLower}`, updatedProfile);

      onSessionCreatedOrJoined(newSession);
    } catch (e: any) {
      setErrorMsg('Fehler beim Erstellen der Session: ' + (e?.message || ''));
    } finally {
      setIsLoading(false);
    }
  };

  const handleJoinSession = async () => {
    setErrorMsg(null);
    const cleanCode = extractCode(joinCodeInput);
    if (!cleanCode || cleanCode.length < 6) {
      setErrorMsg('Bitte gib einen vollständigen 6-stelligen Beitritts-Code ein.');
      return;
    }

    setIsLoading(true);
    try {
      let session = await storageGet<SessionMeta>(`session:${cleanCode}:meta`);

      // Try character ambiguity fixes (0 vs O, 1 vs I)
      if (!session) {
        const alt1 = cleanCode.replace(/0/g, 'O').replace(/1/g, 'I');
        if (alt1 !== cleanCode) session = await storageGet<SessionMeta>(`session:${alt1}:meta`);
      }
      if (!session) {
        const alt2 = cleanCode.replace(/O/g, '0').replace(/I/g, '1');
        if (alt2 !== cleanCode) session = await storageGet<SessionMeta>(`session:${alt2}:meta`);
      }

      // Try fallback scan over all sessions
      if (!session) {
        try {
          const allMetas = await storageGetMany('session:', ':meta');
          for (const s of Object.values(allMetas)) {
            const m = s as SessionMeta;
            if (m?.code?.toUpperCase() === cleanCode || m?.code?.toUpperCase() === cleanCode.replace(/0/g, 'O')) {
              session = m;
              break;
            }
          }
        } catch (_e) {}
      }

      if (!session) {
        setErrorMsg(`Keine Session mit dem Code „${cleanCode}“ gefunden. Bitte prüfe die Eingabe oder erstelle eine neue Gruppe.`);
        setIsLoading(false);
        return;
      }

      const effectiveCode = session.code || cleanCode;

      // Check if already a member or admin
      const existingMember = session.members.find((m) =>
        m.user.toLowerCase() === usernameLower ||
        (currentUser.id && m.userId === currentUser.id)
      );

      if (existingMember) {
        let changed = false;
        if (!existingMember.active) {
          existingMember.active = true;
          changed = true;
        }
        if (!existingMember.userId && currentUser.id) {
          existingMember.userId = currentUser.id;
          changed = true;
        }
        if (existingMember.displayName !== currentUser.displayName) {
          existingMember.displayName = currentUser.displayName;
          changed = true;
        }
        if (changed) {
          await storageSet(`session:${effectiveCode}:meta`, session);
        }
        // Repair the profile index when an existing member joins from another device.
        await storageSet(`user:${usernameLower}`, {
          ...currentUser, sessions: Array.from(new Set([...(currentUser.sessions || []), effectiveCode])),
        });
        onSessionCreatedOrJoined(session);
        setIsLoading(false);
        return;
      }

      // Check member count limit (20 max)
      const activeCount = session.members.filter((m) => m.active).length;
      if (activeCount >= 20) {
        setErrorMsg('Diese Session ist voll (maximal 20 Mitglieder).');
        setIsLoading(false);
        return;
      }

      const penaltyCents = Math.round(penaltyEuro * 100);
      const newMember: SessionMember = {
        user: usernameLower,
        userId: currentUser.id,
        displayName: currentUser.displayName,
        joinedAt: new Date().toISOString(),
        penaltyCents,
        active: true,
      };

      const updatedMembers = [...session.members, newMember];
      const updatedSession: SessionMeta = {
        ...session,
        members: updatedMembers,
      };

      await storageSet(`session:${effectiveCode}:meta`, updatedSession);

      // Section 5.2/11: joining mid-week (Tue-Sun) means no participation in running week
      if (isMidWeek) {
        const joinWeekKey = getBerlinISOWeek(new Date());
        await storageSet(`session:${effectiveCode}:week:${joinWeekKey}:user:${usernameLower}`, {
          goal: 0,
          checks: [],
          penaltyCentsSnapshot: penaltyCents,
          joinedMidWeek: true,
          lockedAt: new Date().toISOString(),
        });
      }

      // Add to user profile sessions
      const updatedUserSessions = Array.from(new Set([...(currentUser.sessions || []), effectiveCode]));
      const updatedProfile: UserProfile = {
        ...currentUser,
        sessions: updatedUserSessions,
      };
      await storageSet(`user:${usernameLower}`, updatedProfile);

      onSessionCreatedOrJoined(updatedSession);
    } catch (e: any) {
      setErrorMsg('Fehler beim Beitreten der Session: ' + (e?.message || ''));
    } finally {
      setIsLoading(false);
    }
  };

  // Check if today is mid-week (Tuesday to Sunday) for join notice
  const berlin = getBerlinParts(new Date());
  const isMidWeek = berlin.dayOfWeek > 1;

  return (
    <div className="fixed inset-0 z-40 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div
        id="session-modal-card"
        className="w-full max-w-md bg-[#0A0A0A] border border-white/15 rounded-3xl shadow-2xl p-6 sm:p-7 text-white flex flex-col gap-5 max-h-[90vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div>
            <h2 className="text-xl font-black uppercase tracking-tight text-white">Mein Profil & Gruppen</h2>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-xs text-white/50">Angemeldet als:</span>
              <span className="text-xs text-[#DFFF00] font-black uppercase">{currentUser.displayName}</span>
              {currentUser.pinHash && (
                <span className="text-[10px] px-1.5 py-0.2 bg-white/10 text-white/70 rounded-md font-mono">PIN geschützt</span>
              )}
            </div>
          </div>
          <button
            type="button"
            id="session-logout-btn"
            onClick={onLogout}
            className="text-xs uppercase tracking-wider font-bold text-white/40 hover:text-red-400 px-2 py-1 transition-colors cursor-pointer"
          >
            Abmelden
          </button>
        </div>

        {/* Tab Controls */}
        <div className="grid grid-cols-3 bg-black/60 p-1.5 rounded-2xl border border-white/10">
          <button
            type="button"
            id="session-tab-list"
            onClick={() => {
              setTab('list');
              setErrorMsg(null);
            }}
            className={`py-2.5 text-xs font-black uppercase tracking-wider rounded-xl transition-all cursor-pointer ${
              tab === 'list' ? 'bg-white/15 text-white shadow-sm' : 'text-white/40 hover:text-white'
            }`}
          >
            Meine Gruppen ({sessions.length})
          </button>
          <button
            type="button"
            id="session-tab-join"
            onClick={() => {
              setTab('join');
              setErrorMsg(null);
            }}
            className={`py-2.5 text-xs font-black uppercase tracking-wider rounded-xl transition-all cursor-pointer ${
              tab === 'join' ? 'bg-[#DFFF00] text-black shadow-md' : 'text-white/40 hover:text-white'
            }`}
          >
            Beitreten
          </button>
          <button
            type="button"
            id="session-tab-create"
            onClick={() => {
              setTab('create');
              setErrorMsg(null);
            }}
            className={`py-2.5 text-xs font-black uppercase tracking-wider rounded-xl transition-all cursor-pointer ${
              tab === 'create' ? 'bg-white/15 text-white shadow-sm' : 'text-white/40 hover:text-white'
            }`}
          >
            Erstellen
          </button>
        </div>

        {errorMsg && (
          <div className="p-3.5 bg-red-500/10 border border-red-500/30 rounded-2xl text-xs font-bold text-red-300 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <p>{errorMsg}</p>
          </div>
        )}

        {/* TAB 1: LIST OF SESSIONS */}
        {tab === 'list' && (
          <div className="flex flex-col gap-3">
            {sessions.length === 0 ? (
              <div className="py-8 text-center flex flex-col items-center gap-2 text-white/50">
                <Users className="w-10 h-10 text-white/20 mb-1" />
                <p className="text-sm font-black uppercase tracking-wider text-white">Noch keine Gruppe verknüpft</p>
                <p className="text-xs text-white/40 max-w-xs">
                  Erstelle jetzt deine eigene Gruppe oder tritt mit einem 6-stelligen Code bei.
                </p>
                <div className="flex flex-wrap justify-center gap-2 mt-4">
                  <button
                    type="button"
                    onClick={() => setTab('join')}
                    className="px-4 py-2.5 bg-[#DFFF00] text-black font-black uppercase tracking-wider text-xs rounded-xl shadow-lg cursor-pointer"
                  >
                    Code eingeben
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab('create')}
                    className="px-4 py-2.5 bg-white/10 hover:bg-white/15 text-white font-black uppercase tracking-wider text-xs rounded-xl cursor-pointer"
                  >
                    Neue Gruppe
                  </button>
                  {onRefreshSessions && (
                    <button
                      type="button"
                      disabled={isRefreshingList}
                      onClick={async () => {
                        setIsRefreshingList(true);
                        try {
                          await onRefreshSessions();
                        } finally {
                          setIsRefreshingList(false);
                        }
                      }}
                      className="px-3.5 py-2.5 bg-white/5 hover:bg-white/10 text-white/70 text-xs font-bold uppercase tracking-wider rounded-xl cursor-pointer transition-colors"
                    >
                      {isRefreshingList ? 'Lädt...' : 'Gruppen suchen'}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {onRefreshSessions && (
                  <div className="flex justify-end pb-1">
                    <button
                      type="button"
                      disabled={isRefreshingList}
                      onClick={async () => {
                        setIsRefreshingList(true);
                        try {
                          await onRefreshSessions();
                        } finally {
                          setIsRefreshingList(false);
                        }
                      }}
                      className="text-[11px] font-bold text-white/50 hover:text-[#DFFF00] transition-colors cursor-pointer"
                    >
                      {isRefreshingList ? 'Synchronisiere...' : '↻ Gruppen synchronisieren'}
                    </button>
                  </div>
                )}
                {sessions.map((s) => {
                  const isAdmin = s.adminUser.toLowerCase() === usernameLower;
                  const activeMembers = s.members.filter((m) => m.active);
                  const isCurrent = s.code === currentSessionCode;

                  return (
                    <div
                      key={s.code}
                      id={`session-card-${s.code}`}
                      onClick={() => onSelectSession(s)}
                      className={`p-4 rounded-2xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                        isCurrent
                          ? 'bg-[#DFFF00]/10 border-[#DFFF00]/50 shadow-md ring-1 ring-[#DFFF00]/30'
                          : 'bg-black/40 border-white/10 hover:border-white/20 hover:bg-white/5'
                      }`}
                    >
                      <div className="flex flex-col gap-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="font-black text-white text-base uppercase tracking-tight truncate">{s.name}</h4>
                          {isAdmin && (
                            <span className="px-1.5 py-0.5 bg-[#DFFF00] text-black text-[9px] font-black uppercase tracking-wider rounded-md flex items-center gap-0.5">
                              <Shield className="w-2.5 h-2.5" /> Admin
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2.5 text-xs text-white/50 font-mono">
                          <span>Code: <strong className="text-[#DFFF00]">{s.code}</strong></span>
                          <span>•</span>
                          <span>{activeMembers.length} {activeMembers.length === 1 ? 'Mitglied' : 'Mitglieder'}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {isCurrent ? (
                          <span className="px-3 py-1 bg-[#DFFF00] text-black text-xs font-black uppercase tracking-wider rounded-xl flex items-center gap-1">
                            <Check className="w-3.5 h-3.5 stroke-[3]" /> Aktiv
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="px-3.5 py-1.5 bg-white/10 hover:bg-white/20 text-xs font-black uppercase tracking-wider text-white rounded-xl transition-colors"
                          >
                            Öffnen
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: JOIN SESSION */}
        {tab === 'join' && (
          <div className="flex flex-col gap-4">
            <div>
              <label className="block text-[10px] uppercase tracking-[0.2em] font-black text-white/40 mb-2">
                6-stelliger Beitritts-Code (oder Einladungslink)
              </label>
              <input
                type="text"
                id="session-join-code-input"
                value={joinCodeInput}
                onChange={(e) => setJoinCodeInput(extractCode(e.target.value))}
                onPaste={(e) => {
                  const pasted = e.clipboardData.getData('text');
                  if (pasted) {
                    e.preventDefault();
                    setJoinCodeInput(extractCode(pasted));
                  }
                }}
                placeholder="z. B. AB7K9X"
                className="w-full text-center uppercase tracking-widest font-mono font-black text-2xl px-4 py-3.5 bg-black/50 border border-white/15 rounded-2xl text-[#DFFF00] focus:outline-hidden focus:border-[#DFFF00]"
              />
              <p className="text-[11px] text-white/40 mt-1.5 text-center">
                Tipp: Du kannst auch den gesamten Einladungslink oder Text einfügen.
              </p>
            </div>

            {/* Penalty Rate Setting */}
            <div className="p-4 bg-black/40 border border-white/10 rounded-2xl flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-black uppercase tracking-wider text-white">
                  Strafsatz pro Einheit
                </label>
                <span className="text-base font-black text-[#DFFF00] font-mono">
                  {penaltyEuro.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €
                </span>
              </div>
              <p className="text-[11px] text-white/50 leading-relaxed">
                Diesen Betrag zahlst du für jedes verfehlte Training in der Woche. Jeder Teilnehmer wählt seinen eigenen Satz.
              </p>
              <input
                type="range"
                id="session-join-penalty-slider"
                min="0.5"
                max="50"
                step="0.5"
                value={penaltyEuro}
                onChange={(e) => setPenaltyEuro(parseFloat(e.target.value))}
                className="w-full accent-[#DFFF00] cursor-pointer mt-1 h-2 bg-white/10 rounded-lg"
              />
              <div className="flex justify-between text-[10px] text-white/40 font-mono">
                <span>0,50 €</span>
                <span>5,00 €</span>
                <span>10,00 €</span>
                <span>20,00 €</span>
                <span>50,00 €</span>
              </div>
            </div>

            {/* Mid-week notice (Section 5.2) */}
            {isMidWeek && (
              <div className="p-3.5 bg-[#DFFF00]/10 border border-[#DFFF00]/30 rounded-2xl text-xs text-[#DFFF00] flex items-start gap-2.5">
                <Sparkles className="w-4 h-4 text-[#DFFF00] shrink-0 mt-0.5" />
                <p className="leading-relaxed font-medium">
                  <strong>Hinweis zur laufenden Woche:</strong> Da die Woche bereits läuft, nimmst du an der aktuellen Woche nicht teil (Ziel 0, keine Strafe). Dein reguläres Training startet ab Montag!
                </p>
              </div>
            )}

            <button
              type="button"
              id="session-join-submit-btn"
              disabled={isLoading || joinCodeInput.trim().length < 6}
              onClick={handleJoinSession}
              className="w-full min-h-[50px] py-3.5 bg-[#DFFF00] hover:scale-[1.02] active:scale-95 text-black font-black uppercase tracking-wider rounded-2xl flex items-center justify-center gap-2 transition-all shadow-xl disabled:opacity-40 cursor-pointer"
            >
              <span>{isLoading ? 'Beitreten...' : 'Session beitreten'}</span>
              <ArrowRight className="w-4 h-4 stroke-[3]" />
            </button>
          </div>
        )}

        {/* TAB 3: CREATE SESSION */}
        {tab === 'create' && (
          <div className="flex flex-col gap-4">
            <div>
              <label className="block text-[10px] uppercase tracking-[0.2em] font-black text-white/40 mb-2">
                Name der Session / Gruppe
              </label>
              <input
                type="text"
                id="session-create-name-input"
                maxLength={40}
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                placeholder="z. B. Gym Beasts 2026, Fitness Bros"
                className="w-full px-4 py-3 bg-black/50 border border-white/15 rounded-2xl text-base font-bold text-white focus:outline-hidden focus:border-[#DFFF00]"
              />
            </div>

            {/* Penalty Rate Setting */}
            <div className="p-4 bg-black/40 border border-white/10 rounded-2xl flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-black uppercase tracking-wider text-white">
                  Dein persönlicher Strafsatz
                </label>
                <span className="text-base font-black text-[#DFFF00] font-mono">
                  {penaltyEuro.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €
                </span>
              </div>
              <p className="text-[11px] text-white/50 leading-relaxed">
                Pro verpasster Einheit in einer Woche. Andere Mitglieder wählen beim Beitritt ihren eigenen Satz.
              </p>
              <input
                type="range"
                id="session-create-penalty-slider"
                min="0.5"
                max="50"
                step="0.5"
                value={penaltyEuro}
                onChange={(e) => setPenaltyEuro(parseFloat(e.target.value))}
                className="w-full accent-[#DFFF00] cursor-pointer mt-1 h-2 bg-white/10 rounded-lg"
              />
              <div className="flex justify-between text-[10px] text-white/40 font-mono">
                <span>0,50 €</span>
                <span>5,00 €</span>
                <span>10,00 €</span>
                <span>20,00 €</span>
                <span>50,00 €</span>
              </div>
            </div>

            <button
              type="button"
              id="session-create-submit-btn"
              disabled={isLoading || sessionName.trim().length < 3}
              onClick={handleCreateSession}
              className="w-full min-h-[50px] py-3.5 bg-[#DFFF00] hover:scale-[1.02] active:scale-95 text-black font-black uppercase tracking-wider rounded-2xl flex items-center justify-center gap-2 transition-all shadow-xl disabled:opacity-40 cursor-pointer"
            >
              <span>{isLoading ? 'Erstelle...' : 'Gruppe erstellen'}</span>
              <Plus className="w-4 h-4 stroke-[3]" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
