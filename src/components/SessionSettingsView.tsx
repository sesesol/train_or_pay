/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Share2,
  Copy,
  Check,
  Shield,
  UserX,
  LogOut,
  Trash2,
  Settings,
  AlertTriangle,
  Sparkles,
  Users,
  Coins,
  CheckCircle,
} from 'lucide-react';
import { SessionMeta, UserProfile, DebtItem } from '../types.ts';
import { formatEuro } from '../lib/settlement.ts';
import { ConfirmModal } from './Modal.tsx';
import { hasUserOpenDebts } from '../lib/settlement.ts';

interface SessionSettingsViewProps {
  session: SessionMeta;
  currentUser: UserProfile;
  usernameLower: string;
  openDebts: DebtItem[];
  onUpdateSessionMeta: (updated: SessionMeta) => Promise<void>;
  onLeaveSession: () => Promise<void>;
  onDeleteSession: () => Promise<void>;
  onSwitchSession: () => void;
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
  onSeedDemoGroup: () => Promise<void>;
}

export const SessionSettingsView: React.FC<SessionSettingsViewProps> = ({
  session,
  currentUser,
  usernameLower,
  openDebts,
  onUpdateSessionMeta,
  onLeaveSession,
  onDeleteSession,
  onSwitchSession,
  onError,
  onSuccess,
  onSeedDemoGroup,
}) => {
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<string | null>(null);

  const isAdmin = session.adminUser.toLowerCase() === usernameLower;
  const currentMember = session.members.find((m) => m.user.toLowerCase() === usernameLower);
  const currentPenaltyEuro = currentMember ? currentMember.penaltyCents / 100 : 5;
  const [newPenaltyEuro, setNewPenaltyEuro] = useState<number>(currentPenaltyEuro);

  const handleCopyInvite = () => {
    const origin = window.location.origin;
    const path = window.location.pathname;
    const inviteUrl = `${origin}${path}#join=${session.code}`;
    const text = `Tritt meiner Gym-Session „${session.name}“ bei! Code: ${session.code}\nLink: ${inviteUrl}`;

    navigator.clipboard.writeText(text);
    setCopiedInvite(true);
    setTimeout(() => setCopiedInvite(false), 2500);
    onSuccess('Einladungstext & Link in die Zwischenablage kopiert!');
  };

  const handleSavePenaltyRate = async () => {
    const updatedMembers = session.members.map((m) => {
      if (m.user.toLowerCase() === usernameLower) {
        return {
          ...m,
          penaltyCents: Math.round(newPenaltyEuro * 100),
        };
      }
      return m;
    });

    const updatedSession: SessionMeta = {
      ...session,
      members: updatedMembers,
    };

    await onUpdateSessionMeta(updatedSession);
    onSuccess(`Strafsatz auf ${formatEuro(Math.round(newPenaltyEuro * 100))} angepasst (gilt ab nächster Woche).`);
  };

  const handleToggleMultiplePerDay = async () => {
    if (!isAdmin) return;
    const currentVal = session.settings?.allowMultiplePerDay || false;
    const updatedSession: SessionMeta = {
      ...session,
      settings: {
        ...session.settings,
        allowMultiplePerDay: !currentVal,
      },
    };
    await onUpdateSessionMeta(updatedSession);
    onSuccess(
      !currentVal
        ? 'Mehrere Einheiten pro Tag wurden erlaubt.'
        : 'Begrenzung auf maximal eine Einheit pro Tag aktiviert.'
    );
  };

  const handleRemoveMember = async (targetUserLower: string) => {
    // Check if target user has open debts
    if (hasUserOpenDebts(targetUserLower, openDebts)) {
      onError('Dieses Mitglied hat noch offene Schulden. Bitte zuerst ausgleichen und als bezahlt markieren.');
      setMemberToRemove(null);
      return;
    }

    const updatedMembers = session.members.map((m) => {
      if (m.user.toLowerCase() === targetUserLower) {
        return { ...m, active: false };
      }
      return m;
    });

    const updatedSession: SessionMeta = {
      ...session,
      members: updatedMembers,
    };

    await onUpdateSessionMeta(updatedSession);
    setMemberToRemove(null);
    onSuccess('Mitglied wurde aus der Session entfernt.');
  };

  const handleLeaveSessionCheck = async () => {
    // Check if current user has open debts
    if (hasUserOpenDebts(usernameLower, openDebts)) {
      onError('Du hast noch offene Schulden! Bitte zuerst Beträge ausgleichen und vom Empfänger bestätigen lassen.');
      setIsLeaving(false);
      return;
    }

    await onLeaveSession();
  };

  return (
    <div className="flex flex-col gap-6 pb-12 animate-in fade-in duration-200">
      {/* Session Overview Card */}
      <div className="bg-white/5 border border-white/10 rounded-3xl p-6 sm:p-7 shadow-xl flex flex-col gap-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-2xl font-black uppercase tracking-tight text-white">{session.name}</h2>
              {isAdmin && (
                <span className="px-2 py-0.5 bg-[#DFFF00] text-black text-[9px] font-black uppercase tracking-wider rounded-md flex items-center gap-1">
                  <Shield className="w-3 h-3" /> Admin
                </span>
              )}
            </div>
            <p className="text-xs text-white/50 font-mono mt-1">
              Erstellt am {new Date(session.createdAt).toLocaleDateString('de-DE')} • {session.members.filter((m) => m.active).length} Mitglieder
            </p>
          </div>

          <button
            type="button"
            onClick={onSwitchSession}
            className="px-3.5 py-2 bg-white/10 hover:bg-white/20 text-white text-xs font-black uppercase tracking-wider rounded-xl transition-colors cursor-pointer"
          >
            Gruppe wechseln
          </button>
        </div>

        {/* Invite Code Box */}
        <div className="p-5 bg-black/40 border border-white/10 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-[0.2em] text-white/40 font-bold">Beitritts-Code</span>
            <span className="text-3xl font-black font-mono text-[#DFFF00] tracking-widest mt-0.5">
              {session.code}
            </span>
          </div>

          <button
            type="button"
            id="copy-invite-btn"
            onClick={handleCopyInvite}
            className="px-5 py-3 bg-[#DFFF00] hover:scale-[1.02] active:scale-95 text-black text-xs font-black uppercase tracking-wider rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg cursor-pointer"
          >
            {copiedInvite ? <Check className="w-4 h-4 stroke-[3]" /> : <Copy className="w-4 h-4 stroke-[2.5]" />}
            <span>{copiedInvite ? 'Kopiert!' : 'Code kopieren'}</span>
          </button>
        </div>
      </div>

      {/* Penalty Rate Setting for Next Week (Section 7.1) */}
      <div className="bg-white/5 border border-white/10 rounded-3xl p-6 sm:p-7 shadow-xl flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Coins className="w-5 h-5 text-[#DFFF00]" />
            <h3 className="text-xs uppercase tracking-[0.2em] text-white/40 font-bold">
              Dein persönlicher Strafsatz
            </h3>
          </div>
          <span className="text-xl font-black text-[#DFFF00] font-mono">
            {formatEuro(Math.round(newPenaltyEuro * 100))}
          </span>
        </div>

        <p className="text-xs text-white/60 leading-relaxed">
          <strong className="text-white font-bold">Hinweis zur Änderung:</strong> Dein geänderter Strafsatz wirkt <strong>erst ab der nächsten Woche</strong>. Die laufende Woche behält den bei Wochenbeginn gültigen Satz ({formatEuro(currentMember?.penaltyCents || 500)}).
        </p>

        <input
          type="range"
          min="0.5"
          max="50"
          step="0.5"
          value={newPenaltyEuro}
          onChange={(e) => setNewPenaltyEuro(parseFloat(e.target.value))}
          className="w-full accent-[#DFFF00] cursor-pointer h-2 bg-white/10 rounded-lg"
        />

        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex gap-2">
            {[2, 5, 10, 20].map((val) => (
              <button
                key={val}
                type="button"
                onClick={() => setNewPenaltyEuro(val)}
                className={`px-3 py-1.5 rounded-xl text-xs font-black font-mono transition-colors ${
                  newPenaltyEuro === val
                    ? 'bg-[#DFFF00] text-black'
                    : 'bg-white/10 text-white hover:bg-white/20'
                }`}
              >
                {val} €
              </button>
            ))}
          </div>

          <button
            type="button"
            id="save-penalty-rate-btn"
            onClick={handleSavePenaltyRate}
            className="px-5 py-2.5 bg-[#DFFF00] hover:scale-[1.02] text-black text-xs font-black uppercase tracking-wider rounded-xl shadow-md cursor-pointer transition-transform"
          >
            Für nächste Woche speichern
          </button>
        </div>
      </div>

      {/* Admin Settings */}
      {isAdmin && (
        <div className="bg-white/5 border border-white/10 rounded-3xl p-6 sm:p-7 shadow-xl flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-[#DFFF00]" />
            <h3 className="text-xs uppercase tracking-[0.2em] text-white/40 font-bold">
              Admin-Einstellungen
            </h3>
          </div>

          <div className="p-4 bg-black/40 border border-white/10 rounded-2xl flex items-center justify-between gap-3">
            <div className="flex flex-col">
              <span className="text-xs font-black uppercase tracking-wider text-white">Mehrere Einheiten pro Tag erlauben</span>
              <span className="text-[11px] text-white/50 mt-0.5">
                Standard ist aus (max. 1 Häkchen pro Kalendertag)
              </span>
            </div>

            <button
              type="button"
              id="admin-toggle-multiple-per-day"
              onClick={handleToggleMultiplePerDay}
              className={`w-12 h-6 rounded-full transition-colors relative cursor-pointer ${
                session.settings?.allowMultiplePerDay ? 'bg-[#DFFF00]' : 'bg-white/20'
              }`}
            >
              <span
                className={`w-5 h-5 rounded-full bg-black absolute top-0.5 transition-transform ${
                  session.settings?.allowMultiplePerDay ? 'left-6.5' : 'left-0.5'
                }`}
              />
            </button>
          </div>
        </div>
      )}

      {/* Members List */}
      <div className="bg-white/5 border border-white/10 rounded-3xl p-6 sm:p-7 shadow-xl flex flex-col gap-4">
        <h3 className="text-xs uppercase tracking-[0.2em] text-white/40 font-bold flex items-center gap-2">
          <Users className="w-4 h-4 text-[#DFFF00]" />
          Mitglieder ({session.members.filter((m) => m.active).length} / 20)
        </h3>

        <div className="space-y-2.5">
          {session.members.map((member) => {
            const isMemberAdmin = member.user.toLowerCase() === session.adminUser.toLowerCase();
            const isMe = member.user.toLowerCase() === usernameLower;

            if (!member.active) {
              return (
                <div
                  key={member.user}
                  className="p-3.5 bg-black/20 border border-white/5 rounded-2xl flex items-center justify-between text-xs text-white/40 font-mono"
                >
                  <span>{member.displayName} (ehemaliges Mitglied)</span>
                  <span>Inaktiv</span>
                </div>
              );
            }

            return (
              <div
                key={member.user}
                className="p-4 bg-black/40 border border-white/10 rounded-2xl flex items-center justify-between text-xs"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center font-mono font-bold text-white">
                    {member.displayName.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex flex-col">
                    <div className="flex items-center gap-1.5">
                      <span className="font-black text-white text-sm uppercase tracking-tight">
                        {member.displayName} {isMe && '(Du)'}
                      </span>
                      {isMemberAdmin && (
                        <span className="px-1.5 py-0.2 bg-[#DFFF00] text-black text-[9px] font-black uppercase rounded-md">
                          Admin
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-white/50 font-mono mt-0.5">
                      Satz: {formatEuro(member.penaltyCents)} / Einheit
                    </span>
                  </div>
                </div>

                {isAdmin && !isMe && (
                  <button
                    type="button"
                    id={`remove-member-${member.user}`}
                    onClick={() => setMemberToRemove(member.user.toLowerCase())}
                    className="p-2 text-white/40 hover:text-red-400 rounded-xl hover:bg-white/5 transition-colors cursor-pointer"
                    title="Mitglied entfernen"
                  >
                    <UserX className="w-4 h-4" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Danger Zone: Leave / Delete */}
      <div className="bg-white/5 border border-red-500/20 rounded-3xl p-6 sm:p-7 shadow-xl flex flex-col gap-4">
        <h3 className="text-xs font-black text-red-400 uppercase tracking-[0.2em] flex items-center gap-1.5">
          <AlertTriangle className="w-4 h-4" />
          Aktionen
        </h3>

        <div className="flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            id="leave-session-btn"
            onClick={() => setIsLeaving(true)}
            className="flex-1 py-3.5 px-4 bg-white/5 hover:bg-white/10 text-white border border-white/10 rounded-2xl text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer transition-colors"
          >
            <LogOut className="w-4 h-4 text-white/50" />
            <span>Session verlassen</span>
          </button>

          {isAdmin && (
            <button
              type="button"
              id="delete-session-btn"
              onClick={() => setIsDeleting(true)}
              className="flex-1 py-3.5 px-4 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 rounded-2xl text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer transition-colors"
            >
              <Trash2 className="w-4 h-4 text-red-400" />
              <span>Session löschen</span>
            </button>
          )}
        </div>
      </div>

      {/* Modals */}
      <ConfirmModal
        isOpen={isLeaving}
        title="Session verlassen?"
        description="Möchtest du diese Gruppe wirklich verlassen? Offene Schulden müssen davor beglichen sein."
        confirmLabel="Verlassen"
        cancelLabel="Abbrechen"
        isDestructive
        onConfirm={handleLeaveSessionCheck}
        onCancel={() => setIsLeaving(false)}
      />

      <ConfirmModal
        isOpen={isDeleting}
        title={`Session „${session.name}“ löschen?`}
        description="Diese Aktion löscht die Session und alle zugehörigen Daten unwiderruflich."
        confirmLabel="Endgültig löschen"
        cancelLabel="Abbrechen"
        isDestructive
        requireInput={session.name}
        inputPlaceholder={`Tippe „${session.name}“`}
        onConfirm={onDeleteSession}
        onCancel={() => setIsDeleting(false)}
      />

      <ConfirmModal
        isOpen={!!memberToRemove}
        title="Mitglied entfernen?"
        description={`Möchtest du dieses Mitglied wirklich aus der Session entfernen? Offene Schulden müssen zuvor ausgeglichen sein.`}
        confirmLabel="Entfernen"
        cancelLabel="Abbrechen"
        isDestructive
        onConfirm={() => {
          if (memberToRemove) handleRemoveMember(memberToRemove);
        }}
        onCancel={() => setMemberToRemove(null)}
      />
    </div>
  );
};
