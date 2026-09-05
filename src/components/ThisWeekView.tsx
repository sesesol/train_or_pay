/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import confetti from 'canvas-confetti';
import {
  Check,
  Calendar,
  AlertTriangle,
  Sparkles,
  Clock,
  ChevronRight,
  Plus,
  Minus,
  Info,
  Users,
  Trophy,
  Flame,
  ShieldCheck,
  Lock,
  Edit3,
  CalendarX,
  ThumbsUp,
  ThumbsDown,
  Send,
  X,
} from 'lucide-react';
import {
  SessionMeta,
  UserWeekData,
  SessionMember,
  UserProfile,
  WorkoutCheck,
  ExceptionRequest,
} from '../types.ts';
import { EXCEPTION_REASONS, statusLabel } from '../lib/exceptions.ts';
import {
  getBerlinParts,
  getWeekDateRange,
  isBerlinPlanningWindow,
  isBerlinLateWindow,
  isAfterMondayMidnight,
  formatBerlinDateTime,
  formatBerlinDate,
  isSameBerlinDay,
  getDaysRemainingInWeek,
  getGermanDayName,
} from '../lib/time.ts';
import { formatEuro } from '../lib/settlement.ts';
import { storageSet } from '../lib/storage.ts';

interface ThisWeekViewProps {
  currentWeekKey: string;
  nextWeekKey: string;
  session: SessionMeta;
  currentUser: UserProfile;
  usernameLower: string;
  myCurrentWeekData: UserWeekData;
  myNextWeekData: UserWeekData | null;
  allMembersCurrentWeek: Record<string, UserWeekData>;
  weekExceptions: ExceptionRequest[];
  excusedByUser: Record<string, number>;
  onUpdateMyWeekData: (weekKey: string, updated: UserWeekData) => Promise<void>;
  onRequestException: (reasonCode?: string, reasonLabel?: string) => Promise<void> | void;
  onDecideException: (request: ExceptionRequest, approve: boolean) => Promise<void> | void;
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
}

export const ThisWeekView: React.FC<ThisWeekViewProps> = ({
  currentWeekKey,
  nextWeekKey,
  session,
  currentUser,
  usernameLower,
  myCurrentWeekData,
  myNextWeekData,
  allMembersCurrentWeek,
  weekExceptions,
  excusedByUser,
  onUpdateMyWeekData,
  onRequestException,
  onDecideException,
  onError,
  onSuccess,
}) => {
  const now = new Date();
  const berlin = getBerlinParts(now);
  const isPlanning = isBerlinPlanningWindow(now); // Sat 00:00 to Sun 23:59
  const isLateWindow = isBerlinLateWindow(now); // Mon 00:00 to 23:59
  const isAfterMonday = isAfterMondayMidnight(now); // Tue 00:00 onwards

  const currentMember = session.members.find((m) => m.user.toLowerCase() === usernameLower);
  const currentPenaltyCents = currentMember?.penaltyCents || 500;

  // Local state for next week planning stepper
  const [nextWeekGoal, setNextWeekGoal] = useState<number>(
    myNextWeekData ? myNextWeekData.goal : 3
  );
  const [isEditingNextWeek, setIsEditingNextWeek] = useState<boolean>(false);

  const daysRemaining = getDaysRemainingInWeek(now);
  const weekRange = getWeekDateRange(currentWeekKey);
  const nextWeekRange = getWeekDateRange(nextWeekKey);

  const currentGoal = myCurrentWeekData.goal;
  const checksCount = myCurrentWeekData.checks.length;

  // Excused units (approved exceptions) count as neither done nor missed.
  const myApprovedExcused = excusedByUser[usernameLower] || 0;
  const excusedForRender = Math.min(myApprovedExcused, Math.max(0, currentGoal - checksCount));
  const missedUnits = Math.max(0, currentGoal - checksCount - excusedForRender);
  const potentialPenalty = missedUnits * (myCurrentWeekData.penaltyCentsSnapshot || currentPenaltyCents);

  // Exception ("Ausnahme") derivations for the current user & partner.
  const myRequests = weekExceptions.filter((e) => e.requester.toLowerCase() === usernameLower);
  const myPendingRequests = myRequests.filter((e) => e.status === 'pending');
  const myActiveExceptionCount = myRequests.filter(
    (e) => e.status === 'pending' || e.status === 'approved'
  ).length;
  // Requests from partners that are still waiting for MY decision.
  const incomingPending = weekExceptions.filter(
    (e) => e.status === 'pending' && e.requester.toLowerCase() !== usernameLower
  );
  const hasOtherActiveMember = session.members.some(
    (m) => m.active && m.user.toLowerCase() !== usernameLower
  );
  const openForRequest = currentGoal - checksCount - myActiveExceptionCount;
  const canRequestException = currentGoal > 0 && openForRequest > 0 && hasOtherActiveMember;

  // Inline reason picker state for requesting an exception.
  const [showReasonPicker, setShowReasonPicker] = useState<boolean>(false);
  const [selectedReason, setSelectedReason] = useState<string>('krank');
  const [customReason, setCustomReason] = useState<string>('');
  const [isSubmittingException, setIsSubmittingException] = useState<boolean>(false);

  const submitException = async () => {
    const opt = EXCEPTION_REASONS.find((r) => r.code === selectedReason);
    const label =
      selectedReason === 'anderer' && customReason.trim()
        ? customReason.trim().slice(0, 80)
        : opt?.label;
    setIsSubmittingException(true);
    try {
      await onRequestException(selectedReason, label);
      setShowReasonPicker(false);
      setCustomReason('');
      setSelectedReason('krank');
    } finally {
      setIsSubmittingException(false);
    }
  };

  // Unreachable goal warning (Section 12)
  // If not allowMultiplePerDay, max 1 check per day.
  const allowMultiple = session.settings?.allowMultiplePerDay || false;
  const isGoalUnreachable = !allowMultiple && currentGoal > 0 && daysRemaining < missedUnits;

  // Check if user already checked in today
  const hasCheckedInToday = myCurrentWeekData.checks.some((c) =>
    isSameBerlinDay(new Date(c.timestamp), now)
  );

  const removeCheckAt = async (checkIndex: number) => {
    if (myCurrentWeekData.lockedAt) {
      onError('Diese Woche ist abgeschlossen und kann nicht mehr geändert werden.');
      return;
    }
    const currentChecks = [...myCurrentWeekData.checks];
    if (checkIndex < 0 || checkIndex >= currentChecks.length) return;
    currentChecks.splice(checkIndex, 1);
    await onUpdateMyWeekData(currentWeekKey, { ...myCurrentWeekData, checks: currentChecks });
    onSuccess('Einheit zurückgenommen.');
  };

  const addCheck = async () => {
    if (myCurrentWeekData.lockedAt) {
      onError('Diese Woche ist abgeschlossen und kann nicht mehr geändert werden.');
      return;
    }
    if (!allowMultiple && hasCheckedInToday) {
      onError('Für heute bereits eingetragen. (Maximal eine Einheit pro Tag)');
      return;
    }
    // Done + excused units may not exceed the weekly goal.
    if (checksCount + excusedForRender >= currentGoal) {
      onError('Du hast dein Trainingsziel für diese Woche bereits erreicht!');
      return;
    }

    const currentChecks = [...myCurrentWeekData.checks, { timestamp: new Date().toISOString() } as WorkoutCheck];
    await onUpdateMyWeekData(currentWeekKey, { ...myCurrentWeekData, checks: currentChecks });

    if (currentChecks.length + excusedForRender >= currentGoal && currentGoal > 0) {
      confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 } });
      onSuccess('Glückwunsch! Ziel für diese Woche erreicht! 🎉');
    } else {
      onSuccess('Einheit abgehakt! Stark gemacht! 💪');
    }
  };

  const handleSaveNextWeekGoal = async (newGoal: number) => {
    const updated: UserWeekData = {
      goal: newGoal,
      checks: myNextWeekData?.checks || [],
      penaltyCentsSnapshot: currentPenaltyCents,
    };
    await onUpdateMyWeekData(nextWeekKey, updated);
    setIsEditingNextWeek(false);
    onSuccess(
      newGoal === 0
        ? `Nächste Woche (${nextWeekKey}) erfolgreich als pausiert festgelegt.`
        : `Ziel für nächste Woche (${nextWeekKey}) auf ${newGoal} ${newGoal === 1 ? 'Einheit' : 'Einheiten'} festgelegt.`
    );
  };

  return (
    <div className="flex flex-col gap-6 pb-12 animate-in fade-in duration-200">
      {/* Week Header & Countdown */}
      <div className="flex flex-col gap-2 bg-white/5 border border-white/10 rounded-3xl p-5 sm:p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-xs uppercase tracking-[0.2em] text-[#DFFF00] font-bold">Aktuelle Trainingswoche</span>
            <span className="text-sm sm:text-base font-black font-mono text-white tracking-wider uppercase mt-0.5">
              KW {currentWeekKey.replace('2026-W', '')} — 2026 • {weekRange.fullRange}
            </span>
          </div>
          <span className="px-3 py-1 bg-white/10 border border-white/10 text-white rounded-full text-xs font-mono font-bold uppercase tracking-wider flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-[#DFFF00]" />
            {berlin.dayOfWeek === 7 ? 'Letzter Tag!' : `Noch ${daysRemaining} Tage`}
          </span>
        </div>

        {/* Unreachable warning */}
        {isGoalUnreachable && (
          <div
            id="unreachable-goal-alert"
            className="mt-2 p-4 bg-red-500/10 border border-red-500/20 rounded-2xl text-xs text-red-300 flex items-start gap-3"
          >
            <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
            <div>
              <strong className="font-black uppercase tracking-wider text-red-400 block mb-0.5">Achtung: Strafe droht!</strong>
              Nur noch {daysRemaining} {daysRemaining === 1 ? 'Tag' : 'Tage'}, aber {missedUnits} offene Einheiten.
              (Ohne Mehrfacheintragung rechnerisch nicht mehr erreichbar!)
            </div>
          </div>
        )}
      </div>

      {/* Main Tracker Card for Current User */}
      <div
        id="my-progress-card"
        className="bg-white/5 border border-white/10 rounded-3xl p-6 sm:p-8 shadow-xl flex flex-col gap-6 relative overflow-hidden"
      >
        {/* Big Background Watermark Number */}
        <div className="absolute top-0 right-0 p-6 pointer-events-none select-none">
          <span className="text-[110px] sm:text-[130px] font-black text-white/5 leading-none font-mono">
            {String(checksCount).padStart(2, '0')}
          </span>
        </div>

        <div className="relative z-10 flex items-start justify-between">
          <div>
            <h2 className="text-xs uppercase tracking-[0.2em] text-[#DFFF00] font-bold">Deine Fortschritte</h2>
            <div className="flex items-baseline gap-2 mt-2">
              <span className="text-4xl sm:text-5xl font-black font-mono text-white">
                {checksCount} <span className="text-white/30 font-light text-2xl sm:text-3xl">/ {currentGoal}</span>
              </span>
              <span className="text-xs uppercase tracking-widest text-white/40 font-bold ml-1">Einheiten</span>
            </div>
          </div>

          <div className="flex flex-col items-end">
            <span className="text-[10px] uppercase tracking-widest text-white/40 font-bold">Strafsatz</span>
            <span className="text-base sm:text-lg font-black text-[#DFFF00] font-mono">
              {formatEuro(myCurrentWeekData.penaltyCentsSnapshot || currentPenaltyCents)}
            </span>
            {potentialPenalty > 0 && (
              <span className="text-[10px] font-mono text-red-400 font-bold uppercase tracking-wider mt-0.5">
                {formatEuro(potentialPenalty)} offen
              </span>
            )}
          </div>
        </div>

        {/* CIRCLES GRID */}
        {currentGoal === 0 ? (
          <div className="relative z-10 py-8 px-4 bg-white/5 border border-dashed border-white/10 rounded-2xl text-center flex flex-col items-center gap-3">
            <span className="text-3xl">🛋️</span>
            <p className="text-base font-black uppercase tracking-wider text-white">Diese Woche pausiert</p>
            <p className="text-xs text-white/50 max-w-xs leading-relaxed">
              Dein Ziel für die laufende Woche ist auf 0 Einheiten fixiert. Du zahlst keine Strafe und erhältst keine Auszahlung.
            </p>
          </div>
        ) : (
          <div className="relative z-10 flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 py-4">
              {Array.from({ length: currentGoal }).map((_, idx) => {
                const isChecked = idx < checksCount;
                const isExcused = idx >= checksCount && idx < checksCount + excusedForRender;
                const firstOpenIdx = checksCount + excusedForRender;
                const isNextToCheck = idx === firstOpenIdx;
                const checkData = isChecked ? myCurrentWeekData.checks[idx] : null;

                const handleClick = () => {
                  if (isChecked) removeCheckAt(idx);
                  else if (isExcused)
                    onError('Dieser Sporttag ist entschuldigt (genehmigte Ausnahme).');
                  else if (isNextToCheck) addCheck();
                };

                return (
                  <button
                    key={idx}
                    type="button"
                    id={`workout-circle-${idx}`}
                    aria-label={`Einheit ${idx + 1} von ${currentGoal}, ${
                      isChecked ? 'erledigt' : isExcused ? 'entschuldigt' : 'nicht erledigt'
                    }`}
                    onClick={handleClick}
                    className={`relative w-20 h-20 sm:w-22 sm:h-22 rounded-full flex flex-col items-center justify-center transition-all cursor-pointer select-none active:scale-95 ${
                      isChecked
                        ? 'border-4 border-[#DFFF00] bg-[#DFFF00] text-black shadow-lg shadow-[#DFFF00]/20'
                        : isExcused
                        ? 'border-4 border-amber-400 bg-amber-400/90 text-black shadow-lg shadow-amber-400/20 cursor-default'
                        : isNextToCheck
                        ? 'border-4 border-dashed border-[#DFFF00]/70 bg-white/5 hover:border-[#DFFF00] hover:bg-[#DFFF00]/10 text-white'
                        : 'border-4 border-dashed border-white/20 bg-white/5 text-white/30'
                    }`}
                  >
                    {isChecked ? (
                      <Check className="w-10 h-10 stroke-[3.5] text-black animate-in zoom-in-75 duration-200" />
                    ) : isExcused ? (
                      <CalendarX className="w-8 h-8 stroke-[2.5] text-black animate-in zoom-in-75 duration-200" />
                    ) : (
                      <span className="text-lg font-black font-mono">{idx + 1}</span>
                    )}

                    {isChecked && checkData && (
                      <span className="text-[9px] font-black font-mono text-black/80 -mt-1 tracking-tight">
                        {formatBerlinDate(checkData.timestamp)}
                      </span>
                    )}
                    {isExcused && (
                      <span className="text-[8px] font-black font-mono text-black/80 -mt-0.5 tracking-tight uppercase">
                        Entschuldigt
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Check info / Today's status */}
            <div className="flex items-center justify-between text-xs text-white/50 pt-3 border-t border-white/10">
              <span className="flex items-center gap-2 font-medium">
                <span
                  className={`w-2.5 h-2.5 rounded-full ${
                    hasCheckedInToday ? 'bg-[#DFFF00]' : 'bg-white/20'
                  }`}
                />
                {hasCheckedInToday ? 'Heute bereits abgehakt' : 'Heute noch nicht abgehakt'}
              </span>

              <span className="text-[11px] text-white/40 uppercase tracking-wider">Tippen zum Abhaken</span>
            </div>
          </div>
        )}

        {/* Goal Status (Locked for current week) */}
        <div className="relative z-10 pt-3 border-t border-white/10 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/60">
              Wochenziel: <strong className="text-white font-black">{currentGoal} {currentGoal === 1 ? 'Einheit' : 'Einheiten'}</strong>
            </span>
          </div>

          <span className="text-[11px] font-mono font-bold text-white/50 bg-white/10 px-2.5 py-1 rounded-lg border border-white/10 flex items-center gap-1.5 select-none">
            <Lock className="w-3.5 h-3.5 text-[#DFFF00]" />
            Laufende Woche fixiert
          </span>
        </div>

        {/* EXCEPTION ("Ausnahme") — request to skip one planned unit this week */}
        {currentGoal > 0 && (
          <div className="relative z-10 pt-3 border-t border-white/10 flex flex-col gap-3">
            {/* Status of my own pending requests */}
            {myPendingRequests.map((req) => (
              <div
                key={req.id}
                className="p-3 bg-amber-400/10 border border-amber-400/30 rounded-2xl text-xs text-amber-200 flex items-start gap-2.5"
              >
                <Clock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <p className="leading-relaxed">
                  <strong className="text-amber-300">Ausnahme angefragt{req.reasonLabel ? ` (${req.reasonLabel})` : ''}.</strong>{' '}
                  Wartet auf Zustimmung deines Partners.
                </p>
              </div>
            ))}

            {!showReasonPicker ? (
              canRequestException && (
                <button
                  type="button"
                  id="request-exception-btn"
                  onClick={() => setShowReasonPicker(true)}
                  className="w-full min-h-[44px] py-2.5 px-4 bg-white/5 hover:bg-amber-400/10 border border-amber-400/30 hover:border-amber-400/60 text-amber-200 font-black uppercase tracking-wider rounded-2xl text-xs transition-colors flex items-center justify-center gap-2 cursor-pointer"
                >
                  <CalendarX className="w-4 h-4" />
                  Sporttag ausnahmsweise auslassen
                </button>
              )
            ) : (
              <div className="p-4 bg-black/40 border border-amber-400/30 rounded-2xl flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black uppercase tracking-wider text-amber-200">Grund (optional)</span>
                  <button
                    type="button"
                    onClick={() => setShowReasonPicker(false)}
                    className="text-white/40 hover:text-white cursor-pointer"
                    aria-label="Abbrechen"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {EXCEPTION_REASONS.map((r) => (
                    <button
                      key={r.code}
                      type="button"
                      onClick={() => setSelectedReason(r.code)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all cursor-pointer ${
                        selectedReason === r.code
                          ? 'bg-amber-400 text-black shadow-md'
                          : 'bg-white/10 hover:bg-white/20 text-white/80'
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
                {selectedReason === 'anderer' && (
                  <input
                    type="text"
                    value={customReason}
                    maxLength={80}
                    onChange={(e) => setCustomReason(e.target.value)}
                    placeholder="Kurze Begründung (optional)"
                    className="w-full px-3 py-2.5 bg-black/50 border border-white/15 rounded-xl text-sm text-white placeholder-white/30 focus:outline-hidden focus:border-amber-400"
                  />
                )}
                <p className="text-[11px] text-white/50 leading-relaxed">
                  Deine Anfrage wird an die Gruppe gesendet und muss von einem anderen Mitglied bestätigt werden. Zukünftige Wochen bleiben unverändert.
                </p>
                <button
                  type="button"
                  id="submit-exception-btn"
                  disabled={isSubmittingException}
                  onClick={submitException}
                  className="w-full min-h-[44px] py-2.5 px-4 bg-amber-400 hover:scale-[1.02] active:scale-95 text-black font-black uppercase tracking-wider rounded-2xl text-xs transition-all disabled:opacity-40 flex items-center justify-center gap-2 cursor-pointer shadow-lg"
                >
                  <Send className="w-4 h-4" />
                  {isSubmittingException ? 'Sende...' : 'Ausnahme-Anfrage senden'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* INCOMING EXCEPTION REQUESTS awaiting my decision */}
      {incomingPending.length > 0 && (
        <div id="incoming-exceptions-card" className="flex flex-col gap-3">
          {incomingPending.map((req) => (
            <div
              key={req.id}
              className="bg-amber-400/10 border-2 border-amber-400/40 rounded-3xl p-5 shadow-xl flex flex-col gap-4"
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-2xl bg-amber-400 text-black flex items-center justify-center shrink-0">
                  <CalendarX className="w-5 h-5 stroke-[2.5]" />
                </div>
                <div className="flex flex-col min-w-0">
                  <h3 className="text-sm font-black uppercase tracking-tight text-white">Ausnahme-Anfrage</h3>
                  <p className="text-xs text-white/70 leading-relaxed mt-0.5">
                    <strong className="text-amber-200">{req.requesterDisplayName}</strong> möchte einen geplanten Sporttag diese Woche ausnahmsweise auslassen{req.reasonLabel ? <> — Grund: <strong className="text-white">{req.reasonLabel}</strong></> : ''}.
                  </p>
                </div>
              </div>
              <div className="flex gap-2.5">
                <button
                  type="button"
                  id={`approve-exception-${req.id}`}
                  onClick={() => onDecideException(req, true)}
                  className="flex-1 min-h-[46px] py-2.5 px-4 bg-[#DFFF00] hover:scale-[1.02] active:scale-95 text-black font-black uppercase tracking-wider rounded-2xl text-xs transition-all flex items-center justify-center gap-2 cursor-pointer shadow-lg"
                >
                  <ThumbsUp className="w-4 h-4" />
                  Zustimmen
                </button>
                <button
                  type="button"
                  id={`reject-exception-${req.id}`}
                  onClick={() => onDecideException(req, false)}
                  className="flex-1 min-h-[46px] py-2.5 px-4 bg-white/10 hover:bg-white/20 text-white font-black uppercase tracking-wider rounded-2xl text-xs transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  <ThumbsDown className="w-4 h-4" />
                  Ablehnen
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* PROMINENT NEXT WEEK PLANNING & EDITING CARD */}
      <div
        id="planning-window-card"
        className="bg-white/5 border-2 border-[#DFFF00]/40 rounded-3xl p-6 shadow-xl flex flex-col gap-4 relative overflow-hidden"
      >
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-[#DFFF00]" />
            <h3 className="text-base font-black uppercase tracking-tight text-white">Nächste Woche planen & bearbeiten</h3>
          </div>
          <span className="text-xs font-mono font-black text-[#DFFF00] bg-[#DFFF00]/10 border border-[#DFFF00]/20 px-2.5 py-1 rounded-lg uppercase tracking-wider">
            KW {nextWeekKey.replace('2026-W', '')} • {nextWeekRange.fullRange}
          </span>
        </div>

        <p className="text-xs text-white/60 leading-relaxed">
          Wähle dein Trainingsziel für die kommende Woche (1 bis 7 Einheiten oder pausieren). Du kannst diesen Wert <strong className="text-white">jederzeit vor Beginn der nächsten Woche beliebig bearbeiten und anpassen</strong>.
        </p>

        {/* Current status of next week */}
        {myNextWeekData && (
          <div className="flex items-center justify-between p-3 bg-white/5 border border-white/10 rounded-xl">
            <div className="flex items-center gap-2">
              <Check className="w-4 h-4 text-[#DFFF00]" />
              <span className="text-xs font-medium text-white/80">
                Aktuell geplantes Ziel: <strong className="text-white font-mono font-bold">{myNextWeekData.goal === 0 ? 'Pausiert (0 Einheiten)' : `${myNextWeekData.goal} ${myNextWeekData.goal === 1 ? 'Einheit' : 'Einheiten'}`}</strong>
              </span>
            </div>
            <span className="text-[10px] font-mono text-[#DFFF00] font-bold uppercase tracking-wider bg-[#DFFF00]/10 px-2 py-0.5 rounded border border-[#DFFF00]/20">
              Jederzeit änderbar
            </span>
          </div>
        )}

        <div className="flex flex-col gap-3 bg-black/40 p-4 sm:p-5 rounded-2xl border border-white/10">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-white/60 font-bold">Neues Wochenziel auswählen:</span>
            <span className="text-2xl font-black text-[#DFFF00] font-mono">
              {nextWeekGoal === 0 ? '0 (Pausiert)' : `${nextWeekGoal} ${nextWeekGoal === 1 ? 'Einheit' : 'Einheiten'}`}
            </span>
          </div>

          {/* Quick preset chips including 0 / Pausieren */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              id="next-week-pause-chip"
              onClick={() => setNextWeekGoal(0)}
              className={`px-3 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all cursor-pointer ${
                nextWeekGoal === 0
                  ? 'bg-amber-400 text-black shadow-md scale-105'
                  : 'bg-white/10 hover:bg-white/20 text-white/80'
              }`}
            >
              🛋️ 0 (Pause)
            </button>

            {[1, 2, 3, 4, 5, 6, 7].map((num) => (
              <button
                key={num}
                type="button"
                id={`next-week-goal-${num}`}
                onClick={() => setNextWeekGoal(num)}
                className={`w-10 h-10 rounded-xl text-sm font-black font-mono transition-all cursor-pointer ${
                  nextWeekGoal === num
                    ? 'bg-[#DFFF00] text-black shadow-md scale-105'
                    : 'bg-white/10 hover:bg-white/20 text-white'
                }`}
              >
                {num}
              </button>
            ))}
          </div>

          {/* Stepper + Save / Update Button */}
          <div className="flex items-center justify-between flex-wrap gap-3 pt-3 border-t border-white/10">
            <div className="flex items-center gap-2">
              <button
                type="button"
                id="next-week-goal-minus"
                disabled={nextWeekGoal <= 0}
                onClick={() => setNextWeekGoal((g) => Math.max(0, g - 1))}
                className="w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-20 text-white flex items-center justify-center font-bold text-lg"
              >
                <Minus className="w-4 h-4" />
              </button>
              <button
                type="button"
                id="next-week-goal-plus"
                disabled={nextWeekGoal >= 7}
                onClick={() => setNextWeekGoal((g) => Math.min(7, g + 1))}
                className="w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-20 text-white flex items-center justify-center font-bold text-lg"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>

            <button
              type="button"
              id="save-next-week-goal-btn"
              onClick={() => handleSaveNextWeekGoal(nextWeekGoal)}
              className="px-6 py-3 bg-[#DFFF00] hover:scale-[1.02] active:scale-95 text-black font-black text-xs uppercase tracking-wider rounded-xl shadow-lg cursor-pointer transition-transform flex items-center gap-2"
            >
              <Edit3 className="w-4 h-4" />
              <span>{myNextWeekData ? 'Ziel für nächste Woche aktualisieren' : 'Ziel für nächste Woche festlegen'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* TEAM OVERVIEW: ALL MEMBERS IN THIS SESSION */}
      <div id="team-overview-section" className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs uppercase tracking-[0.2em] text-white/40 font-bold flex items-center gap-2">
            <Users className="w-4 h-4 text-[#DFFF00]" />
            Gruppe ({session.members.filter((m) => m.active).length} Mitglieder)
          </h3>
        </div>

        <div className="grid grid-cols-1 gap-3">
          {session.members
            .filter((m) => m.active)
            .map((member) => {
              const memberLower = member.user.toLowerCase();
              const isMe = memberLower === usernameLower;
              const memberData = allMembersCurrentWeek[memberLower] || {
                goal: 0,
                checks: [],
                penaltyCentsSnapshot: member.penaltyCents,
              };

              const completed = memberData.checks?.length || 0;
              const goal = memberData.goal;
              const memberExcused = Math.min(excusedByUser[memberLower] || 0, Math.max(0, goal - completed));
              const isSuccess = goal > 0 && completed >= goal;
              // Sorted check dates (what the partner actually did, and when).
              const checkDates = (memberData.checks || [])
                .map((c) => c.timestamp)
                .sort()
                .map((ts) => formatBerlinDate(ts));

              return (
                <div
                  key={member.user}
                  id={`member-row-${member.user}`}
                  className={`p-4 rounded-2xl border transition-all flex items-center justify-between gap-3 ${
                    isMe
                      ? 'bg-white/10 border-white/20 shadow-md'
                      : 'bg-white/5 border-white/10 hover:bg-white/10'
                  }`}
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div
                      className={`w-11 h-11 rounded-2xl flex items-center justify-center font-black text-sm shrink-0 ${
                        isSuccess
                          ? 'bg-[#DFFF00] text-black'
                          : goal === 0
                          ? 'bg-white/5 text-white/30 border border-white/10'
                          : 'bg-white/10 text-white border border-white/10'
                      }`}
                    >
                      {isSuccess ? (
                        <Trophy className="w-6 h-6 stroke-[2.5]" />
                      ) : (
                        <span className="font-mono">{member.displayName.slice(0, 2).toUpperCase()}</span>
                      )}
                    </div>

                    <div className="flex flex-col min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-black text-white text-sm uppercase tracking-tight truncate">
                          {member.displayName} {isMe && '(Du)'}
                        </span>
                        {isSuccess && (
                          <span className="text-[9px] bg-[#DFFF00] text-black px-2 py-0.5 rounded-full font-black uppercase tracking-wider">
                            Goal
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-white/50 font-mono mt-0.5">
                        {goal === 0 ? 'Pausiert' : `${completed} / ${goal} Einheiten`}
                        {memberExcused > 0 && <span className="text-amber-300"> • {memberExcused} entsch.</span>}
                        {' '}• {formatEuro(member.penaltyCents)}
                      </span>
                      {/* Dates the member actually trained (visible to the partner) */}
                      {checkDates.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {checkDates.map((d, i) => (
                            <span
                              key={i}
                              className="px-1.5 py-0.5 bg-[#DFFF00]/15 text-[#DFFF00] text-[9px] font-mono font-bold rounded-md flex items-center gap-0.5"
                            >
                              <Check className="w-2.5 h-2.5 stroke-[3]" />
                              {d}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Mini Circles Indicator: done (lime) + excused (amber) + open */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {goal > 0 ? (
                      <div className="flex items-center gap-1">
                        {Array.from({ length: Math.min(goal, 7) }).map((_, cIdx) => {
                          const isDone = cIdx < completed;
                          const isExc = !isDone && cIdx < completed + memberExcused;
                          return (
                            <span
                              key={cIdx}
                              className={`w-4 h-4 rounded-full flex items-center justify-center text-[8px] ${
                                isDone
                                  ? 'bg-[#DFFF00] text-black font-black'
                                  : isExc
                                  ? 'bg-amber-400 text-black font-black'
                                  : 'bg-white/5 border border-white/20'
                              }`}
                            />
                          );
                        })}
                        {goal > 7 && <span className="text-[10px] font-mono text-white/40">+{goal - 7}</span>}
                      </div>
                    ) : (
                      <span className="text-xs font-mono text-white/40 italic">0/0</span>
                    )}
                  </div>
                </div>
              );
            })}
        </div>

        {/* Legend + full transparency list of this week's exceptions */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] font-bold uppercase tracking-wider text-white/50 px-1">
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-[#DFFF00]" /> Erledigt</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-amber-400" /> Entschuldigt</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-white/10 border border-white/25" /> Offen / Verpasst</span>
        </div>

        {weekExceptions.length > 0 && (
          <div className="flex flex-col gap-2 mt-1">
            <h4 className="text-[10px] uppercase tracking-[0.2em] text-white/40 font-bold flex items-center gap-2">
              <CalendarX className="w-3.5 h-3.5 text-amber-400" />
              Ausnahmen diese Woche
            </h4>
            {weekExceptions
              .slice()
              .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
              .map((req) => {
                const badge =
                  req.status === 'approved'
                    ? 'bg-amber-400/20 text-amber-300 border-amber-400/30'
                    : req.status === 'rejected'
                    ? 'bg-red-500/10 text-red-300 border-red-500/30'
                    : 'bg-white/10 text-white/70 border-white/20';
                return (
                  <div
                    key={req.id}
                    className="flex items-center justify-between gap-2 p-2.5 bg-white/5 border border-white/10 rounded-xl text-xs"
                  >
                    <span className="text-white/80 min-w-0 truncate">
                      <strong className="text-white">{req.requesterDisplayName}</strong>
                      {req.reasonLabel ? <span className="text-white/50"> — {req.reasonLabel}</span> : ''}
                    </span>
                    <span className={`px-2 py-0.5 rounded-md border font-black uppercase tracking-wider text-[9px] shrink-0 ${badge}`}>
                      {statusLabel(req.status)}
                    </span>
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
};
