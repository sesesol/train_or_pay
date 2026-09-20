import React, { useState } from 'react';
import { Dumbbell, Lock } from 'lucide-react';
import { UserProfile } from '../types.ts';
import { apiRequest } from '../lib/api.ts';

interface AuthScreenProps {
  onLoginSuccess: (profile: UserProfile, username: string, prefillJoinCode?: string) => void;
  onError: (message: string) => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({ onLoginSuccess }) => {
  const [mode, setMode] = useState<'login' | 'register' | 'migrate'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [proof, setProof] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const prefill = `${window.location.search} ${window.location.hash}`.match(/join=([A-Za-z0-9]+)/)?.[1]?.toUpperCase();
  const inputClass = 'w-full px-4 py-3.5 bg-black/50 border border-white/20 rounded-2xl text-base text-white focus:outline-hidden focus:border-[#DFFF00]';
  const changeMode = (next: typeof mode) => { setMode(next); setError(''); setPassword(''); setConfirmation(''); setProof(''); };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (loading) return;
    setError('');
    if (mode !== 'login' && password !== confirmation) { setError('Die Passwörter stimmen nicht überein.'); return; }
    setLoading(true);
    try {
      const result = await apiRequest<{ profile: UserProfile; usernameLower: string }>(`/auth/${mode}`, { username, password, proof });
      await onLoginSuccess(result.profile, result.usernameLower, prefill);
    } catch (error: any) { setError(error.message || 'Anmeldung fehlgeschlagen. Bitte erneut versuchen.'); }
    finally { setLoading(false); }
  }

  return <main className="min-h-screen bg-[#0A0A0A] text-white flex flex-col justify-center p-5 max-w-md mx-auto">
    <div className="text-center mb-8">
      <Dumbbell className="w-12 h-12 text-[#DFFF00] mx-auto mb-4" />
      <h1 className="text-3xl font-black uppercase tracking-tight">Trainieren <span className="text-[#DFFF00]">oder zahlen</span></h1>
      <p className="text-sm text-white/60 mt-3">Ein Konto für alle Geräte. Deine Gruppen bleiben mit deinem Konto verbunden.</p>
    </div>
    <div className="bg-white/5 border border-white/10 rounded-3xl p-6">
      <h2 className="text-xl font-bold mb-5">{mode === 'login' ? 'Anmelden' : mode === 'register' ? 'Konto erstellen' : 'Bestehendes Konto umstellen'}</h2>
      {mode === 'migrate' && <p className="text-sm text-white/70 mb-5">Setze einmalig ein Passwort für dein bisheriges Konto. Verwende deine alte PIN. Hattest du keine PIN, benötigst du einen persönlichen Umstellungscode vom Betreiber. Deine Gruppen und Trainingsdaten bleiben erhalten.</p>}
      {prefill && <p className="text-sm text-[#DFFF00] mb-4">Gruppeneinladung: {prefill}</p>}
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="text-sm">Benutzername
          <input id="auth-username-input" name="username" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required minLength={3} maxLength={20} className={`${inputClass} mt-2`} />
        </label>
        {mode === 'migrate' && <label className="text-sm">Alte PIN oder persönlicher Umstellungscode
          <input name="proof" type="password" autoComplete="off" value={proof} onChange={e => setProof(e.target.value)} required maxLength={1024} className={`${inputClass} mt-2`} />
        </label>}
        <label className="text-sm">{mode === 'login' ? 'Passwort' : 'Neues Passwort (mindestens 12 Zeichen)'}
          <input id="auth-password-input" name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} required minLength={mode === 'login' ? 1 : 12} maxLength={128} className={`${inputClass} mt-2`} />
        </label>
        {mode !== 'login' && <label className="text-sm">Passwort wiederholen
          <input name="confirmation" type="password" autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} required minLength={12} maxLength={128} className={`${inputClass} mt-2`} />
        </label>}
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <button id="auth-submit-btn" disabled={loading} className="w-full min-h-[52px] bg-[#DFFF00] text-black font-bold rounded-2xl disabled:opacity-50 cursor-pointer">{loading ? 'Bitte warten …' : mode === 'login' ? 'Anmelden' : mode === 'register' ? 'Konto erstellen' : 'Passwort setzen & anmelden'}</button>
      </form>
      <div className="flex flex-col gap-3 mt-5 text-sm">
        {mode !== 'login' && <button disabled={loading} onClick={() => changeMode('login')} className="text-[#DFFF00] cursor-pointer">Zur Anmeldung</button>}
        {mode === 'login' && <>
          <button disabled={loading} onClick={() => changeMode('register')} className="text-[#DFFF00] cursor-pointer">Noch kein Konto? Registrieren</button>
          <button disabled={loading} onClick={() => changeMode('migrate')} className="text-white/70 cursor-pointer">Bestehendes Konto umstellen (bisher ohne Passwort)</button>
        </>}
      </div>
    </div>
    <p className="text-xs text-white/50 mt-6 flex gap-2"><Lock className="w-4 h-4 shrink-0" />Auf einem neuen Gerät einmal anmelden. Danach werden deine bestehenden Gruppen automatisch geladen.</p>
  </main>;
};
