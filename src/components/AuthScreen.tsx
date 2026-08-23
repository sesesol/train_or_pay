/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Dumbbell, ShieldAlert, ArrowRight, UserPlus, Lock, Sparkles } from 'lucide-react';
import { UserProfile } from '../types.ts';
import { storageGet, storageSet } from '../lib/storage.ts';

interface AuthScreenProps {
  onLoginSuccess: (userProfile: UserProfile, usernameLower: string, prefillJoinCode?: string) => void;
  onError: (msg: string) => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({ onLoginSuccess, onError }) => {
  const [usernameInput, setUsernameInput] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [recentUsers, setRecentUsers] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [step, setStep] = useState<'username' | 'pin_verify' | 'pin_create'>('username');
  const [pendingProfile, setPendingProfile] = useState<UserProfile | null>(null);
  const [pendingUsernameLower, setPendingUsernameLower] = useState('');
  const [prefillJoinCode, setPrefillJoinCode] = useState<string | undefined>(undefined);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Check URL hash or query for #join=CODE
  useEffect(() => {
    try {
      const hash = window.location.hash;
      const search = window.location.search;
      let code: string | undefined;

      if (hash.includes('join=')) {
        const match = hash.match(/join=([A-Za-z0-9]+)/);
        if (match && match[1]) code = match[1].toUpperCase();
      } else if (search.includes('join=')) {
        const urlParams = new URLSearchParams(search);
        const j = urlParams.get('join');
        if (j) code = j.toUpperCase();
      }

      if (code) {
        setPrefillJoinCode(code);
      }
    } catch (_e) {
      // ignore
    }

    // Load recent users list from shared storage
    const loadRecent = async () => {
      try {
        const recent = await storageGet<string[]>('recent:users');
        if (Array.isArray(recent)) {
          setRecentUsers(recent.slice(0, 5));
        }
      } catch (_e) {
        // ignore
      }
    };
    loadRecent();
  }, []);

  const validateUsername = (name: string): string | null => {
    const trimmed = name.trim();
    if (!trimmed) {
      return 'Bitte gib einen Benutzernamen ein.';
    }
    if (trimmed.length < 3) {
      return 'Der Name muss mindestens 3 Zeichen lang sein.';
    }
    if (trimmed.length > 20) {
      return 'Der Name darf maximal 20 Zeichen lang sein.';
    }
    // Allowed: letters (incl. ä, ö, ü, ß), digits, _, -, spaces
    const validRegex = /^[a-zA-Z0-9äöüÄÖÜß_\-\s]+$/;
    if (!validRegex.test(trimmed)) {
      return 'Erlaubt sind nur Buchstaben, Zahlen, Bindestrich, Unterstrich und Leerzeichen.';
    }
    return null;
  };

  const handleContinue = async (rawName = usernameInput) => {
    setValidationError(null);
    const err = validateUsername(rawName);
    if (err) {
      setValidationError(err);
      return;
    }

    const trimmed = rawName.trim();
    const usernameLower = trimmed.toLowerCase();
    setIsLoading(true);

    try {
      const existingUser = await storageGet<UserProfile>(`user:${usernameLower}`);

      if (existingUser) {
        // User exists! Check if PIN is required
        if (existingUser.pinHash) {
          setPendingProfile(existingUser);
          setPendingUsernameLower(usernameLower);
          setStep('pin_verify');
          setIsLoading(false);
          return;
        }

        // Direct login
        await updateRecentUsers(existingUser.displayName);
        onLoginSuccess(existingUser, usernameLower, prefillJoinCode);
      } else {
        // New user creation flow
        setPendingUsernameLower(usernameLower);
        setPendingProfile({
          displayName: trimmed,
          pinHash: null,
          createdAt: new Date().toISOString(),
          sessions: [],
        });
        setStep('pin_create');
      }
    } catch (e: any) {
      onError('Fehler beim Laden des Benutzerprofils: ' + (e?.message || ''));
    } finally {
      setIsLoading(false);
    }
  };

  const updateRecentUsers = async (displayName: string) => {
    try {
      const current = (await storageGet<string[]>('recent:users')) || [];
      const updated = [displayName, ...current.filter((u) => u.toLowerCase() !== displayName.toLowerCase())].slice(0, 5);
      await storageSet('recent:users', updated);
    } catch (_e) {
      // non-critical
    }
  };

  const handleVerifyPin = async () => {
    if (!pendingProfile) return;
    if (pinInput.trim() !== (pendingProfile.pinHash || '')) {
      setValidationError('Falsche PIN. Bitte erneut versuchen.');
      return;
    }
    await updateRecentUsers(pendingProfile.displayName);
    onLoginSuccess(pendingProfile, pendingUsernameLower, prefillJoinCode);
  };

  const handleFinishCreateUser = async (withPin: boolean) => {
    if (!pendingProfile) return;
    setIsLoading(true);

    let pin: string | null = null;
    if (withPin) {
      const cleanPin = pinInput.trim();
      if (cleanPin.length !== 4 || !/^\d{4}$/.test(cleanPin)) {
        setValidationError('Die PIN muss genau 4 Ziffern enthalten.');
        setIsLoading(false);
        return;
      }
      pin = cleanPin;
    }

    const newProfile: UserProfile = {
      ...pendingProfile,
      pinHash: pin,
      createdAt: new Date().toISOString(),
    };

    try {
      await storageSet(`user:${pendingUsernameLower}`, newProfile);
      await updateRecentUsers(newProfile.displayName);
      onLoginSuccess(newProfile, pendingUsernameLower, prefillJoinCode);
    } catch (e: any) {
      onError('Benutzer konnte nicht gespeichert werden.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-white flex flex-col justify-between p-4 sm:p-6 max-w-md mx-auto">
      {/* Top Header */}
      <div className="pt-8 sm:pt-12 flex flex-col items-center text-center">
        <div className="w-16 h-16 rounded-3xl bg-[#DFFF00] flex items-center justify-center shadow-xl shadow-[#DFFF00]/10 mb-5">
          <Dumbbell className="w-8 h-8 text-black stroke-[2.5]" />
        </div>
        <h1 className="text-3xl sm:text-4xl font-black uppercase tracking-tighter text-white">
          Trainieren <span className="text-[#DFFF00]">oder zahlen</span>
        </h1>
        <p className="text-xs uppercase tracking-wider text-white/50 mt-2 max-w-xs leading-relaxed font-bold">
          Gym-Accountability für Freunde. Erreiche deine Ziele oder zahle Strafen an die Gruppe.
        </p>

        {prefillJoinCode && (
          <div className="mt-4 px-3.5 py-1.5 bg-[#DFFF00]/10 border border-[#DFFF00]/30 rounded-full text-xs font-black uppercase tracking-wider text-[#DFFF00] flex items-center gap-1.5 animate-pulse font-mono">
            <Sparkles className="w-3.5 h-3.5" />
            Session-Einladung: {prefillJoinCode}
          </div>
        )}
      </div>

      {/* Main Card */}
      <div className="my-auto py-6">
        <div className="bg-white/5 border border-white/10 rounded-3xl p-6 sm:p-7 shadow-2xl flex flex-col gap-6">
          {step === 'username' && (
            <>
              <div>
                <label htmlFor="auth-username-input" className="block text-[10px] uppercase tracking-[0.2em] font-black text-white/40 mb-2.5">
                  Dein Benutzername
                </label>
                <div className="relative">
                  <input
                    id="auth-username-input"
                    type="text"
                    value={usernameInput}
                    onChange={(e) => {
                      setUsernameInput(e.target.value);
                      if (validationError) setValidationError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleContinue();
                    }}
                    placeholder="z. B. Ali, Bea oder Cem"
                    maxLength={20}
                    className="w-full px-4 py-3.5 bg-black/50 border border-white/15 rounded-2xl text-base font-bold text-white placeholder-white/20 focus:outline-hidden focus:border-[#DFFF00] transition-all"
                  />
                </div>
                {validationError && (
                  <p className="text-xs text-red-400 mt-2 font-bold uppercase tracking-wider">{validationError}</p>
                )}
              </div>

              <button
                type="button"
                id="auth-continue-btn"
                disabled={isLoading || !usernameInput.trim()}
                onClick={() => handleContinue()}
                className="w-full min-h-[52px] py-3.5 px-4 bg-[#DFFF00] hover:scale-[1.02] active:scale-95 text-black font-black uppercase tracking-wider rounded-2xl flex items-center justify-center gap-2 transition-all shadow-xl disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                <span>{isLoading ? 'Prüfe...' : 'Weiter'}</span>
                <ArrowRight className="w-4 h-4 stroke-[3]" />
              </button>

              {/* Recent Users list */}
              {recentUsers.length > 0 && (
                <div className="pt-3 border-t border-white/10">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-white/40 font-bold mb-2.5">Zuletzt verwendet:</p>
                  <div className="flex flex-wrap gap-2">
                    {recentUsers.map((name) => (
                      <button
                        key={name}
                        type="button"
                        id={`auth-recent-user-${name}`}
                        onClick={() => {
                          setUsernameInput(name);
                          handleContinue(name);
                        }}
                        className="px-3.5 py-1.5 bg-white/10 hover:bg-[#DFFF00] hover:text-black text-xs font-black uppercase tracking-tight text-white rounded-xl transition-all flex items-center gap-1.5 cursor-pointer font-mono"
                      >
                        <span>{name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {step === 'pin_verify' && (
            <div className="flex flex-col gap-5">
              <div className="text-center">
                <div className="w-12 h-12 mx-auto rounded-2xl bg-white/10 flex items-center justify-center text-[#DFFF00] mb-3">
                  <Lock className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-black uppercase tracking-tight text-white">PIN für „{pendingProfile?.displayName}“</h3>
                <p className="text-xs text-white/50 mt-1">
                  Dieses Konto ist mit einer 4-stelligen PIN geschützt.
                </p>
              </div>

              <div>
                <input
                  type="password"
                  id="auth-pin-verify-input"
                  maxLength={4}
                  pattern="[0-9]*"
                  inputMode="numeric"
                  value={pinInput}
                  onChange={(e) => {
                    setPinInput(e.target.value);
                    if (validationError) setValidationError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleVerifyPin();
                  }}
                  placeholder="••••"
                  className="w-full text-center tracking-widest text-3xl px-4 py-3 bg-black/50 border border-white/15 rounded-2xl text-[#DFFF00] font-mono focus:outline-hidden focus:border-[#DFFF00]"
                  autoFocus
                />
                {validationError && (
                  <p className="text-xs text-red-400 mt-2 text-center font-bold uppercase tracking-wider">{validationError}</p>
                )}
              </div>

              <div className="flex gap-2.5">
                <button
                  type="button"
                  id="auth-pin-back-btn"
                  onClick={() => {
                    setStep('username');
                    setPinInput('');
                    setValidationError(null);
                  }}
                  className="flex-1 min-h-[48px] py-2.5 px-4 bg-white/10 hover:bg-white/15 text-white font-black uppercase tracking-wider rounded-2xl text-xs transition-colors cursor-pointer"
                >
                  Zurück
                </button>
                <button
                  type="button"
                  id="auth-pin-submit-btn"
                  onClick={handleVerifyPin}
                  disabled={pinInput.length < 4}
                  className="flex-1 min-h-[48px] py-2.5 px-4 bg-[#DFFF00] hover:scale-[1.02] active:scale-95 text-black font-black uppercase tracking-wider rounded-2xl text-xs transition-all disabled:opacity-40 cursor-pointer shadow-lg"
                >
                  Anmelden
                </button>
              </div>

              <p className="text-[10px] uppercase tracking-wider text-white/40 text-center leading-relaxed">
                PIN vergessen? Neuen Namen anlegen & in der Gruppe entfernen lassen.
              </p>
            </div>
          )}

          {step === 'pin_create' && (
            <div className="flex flex-col gap-5">
              <div className="text-center">
                <div className="w-12 h-12 mx-auto rounded-2xl bg-[#DFFF00]/20 text-[#DFFF00] flex items-center justify-center mb-3">
                  <UserPlus className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-black uppercase tracking-tight text-white">Willkommen, {pendingProfile?.displayName}!</h3>
                <p className="text-xs text-white/50 mt-1">
                  Möchtest du eine optionale 4-stellige PIN setzen, um versehentliches Übernehmen zu vermeiden?
                </p>
              </div>

              <div>
                <label className="block text-[10px] uppercase tracking-[0.2em] font-black text-white/40 mb-2">
                  4-stellige PIN (optional)
                </label>
                <input
                  type="password"
                  id="auth-pin-create-input"
                  maxLength={4}
                  pattern="[0-9]*"
                  inputMode="numeric"
                  value={pinInput}
                  onChange={(e) => {
                    setPinInput(e.target.value);
                    if (validationError) setValidationError(null);
                  }}
                  placeholder="z. B. 1234 (oder leer)"
                  className="w-full text-center tracking-widest text-xl px-4 py-3 bg-black/50 border border-white/15 rounded-2xl text-white font-mono focus:outline-hidden focus:border-[#DFFF00]"
                />
                {validationError && (
                  <p className="text-xs text-red-400 mt-2 text-center font-bold uppercase tracking-wider">{validationError}</p>
                )}
              </div>

              <div className="flex flex-col gap-2.5">
                {pinInput.trim().length === 4 ? (
                  <button
                    type="button"
                    id="auth-create-with-pin-btn"
                    disabled={isLoading}
                    onClick={() => handleFinishCreateUser(true)}
                    className="w-full min-h-[48px] py-3 px-4 bg-[#DFFF00] hover:scale-[1.02] active:scale-95 text-black font-black uppercase tracking-wider rounded-2xl text-xs transition-all cursor-pointer shadow-lg"
                  >
                    Mit PIN speichern & starten
                  </button>
                ) : (
                  <button
                    type="button"
                    id="auth-create-skip-pin-btn"
                    disabled={isLoading}
                    onClick={() => handleFinishCreateUser(false)}
                    className="w-full min-h-[48px] py-3 px-4 bg-[#DFFF00] hover:scale-[1.02] active:scale-95 text-black font-black uppercase tracking-wider rounded-2xl text-xs transition-all cursor-pointer shadow-lg"
                  >
                    Ohne PIN fortfahren
                  </button>
                )}
                <button
                  type="button"
                  id="auth-create-back-btn"
                  onClick={() => {
                    setStep('username');
                    setPinInput('');
                    setValidationError(null);
                  }}
                  className="w-full py-2.5 text-xs font-bold uppercase tracking-wider text-white/40 hover:text-white transition-colors cursor-pointer"
                >
                  Anderen Namen wählen
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Mandatory Security Banner (Section 2.4) */}
      <div
        id="security-disclaimer-banner"
        className="p-4 bg-white/5 border border-white/10 rounded-2xl flex items-start gap-3 text-xs text-white/50"
      >
        <ShieldAlert className="w-4 h-4 text-[#DFFF00] shrink-0 mt-0.5" />
        <p className="leading-relaxed font-medium">
          <strong className="text-white font-bold">Hinweis:</strong> Diese App ist für private Freundesgruppen gedacht. Es gibt keinen echten Passwortschutz — gib hier keine sensiblen Daten ein.
        </p>
      </div>
    </div>
  );
};
