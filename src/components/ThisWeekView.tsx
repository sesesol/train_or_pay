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
} from 'lucide-react';
import {
  SessionMeta,
  UserWeekData,
  SessionMember,
  UserProfile,
  WorkoutCheck,
} from '../types.ts';
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
  onUpdateMyWeekData: (weekKey: string, updated: UserWeekData) => Promise<void>;
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
  onUpdateMyWeekData,
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

  // Local state for goal setting steppers
  const [isEditingGoal, setIsEditingGoal] = useState(false);
  const [selectedGoal, setSelectedGoal] = useState<number>(myCurrentWeekData.goal);
  const [nextWeekGoal, setNextWeekGoal] = useState<number>(myNextWeekData ? myNextWeekData.goal : 3);
  const [selectedCheckDetail, setSelectedCheckDetail] = useState<{ index: number; check: WorkoutCheck } | null>(null);

  const daysRemaining = getDaysRemainingInWeek(now);
  const weekRange = getWeekDateRange(currentWeekKey);
  const nextWeekRange = getWeekDateRange(nextWeekKey);

  const currentGoal = myCurrentWeekData.goal;
  const checksCount = myCurrentWeekData.checks.length;
  const missedUnits = Math.max(0, currentGoal - checksCount);
  const potentialPenalty = missedUnits * (myCurrentWeekData.penaltyCentsSnapshot || currentPenaltyCents);

  // Unreachable goal warning (Section 12)
  // If not allowMultiplePerDay, max 1 check per day.
  const allowMultiple = session.settings?.allowMultiplePerDay || false;
  const isGoalUnreachable = !allowMultiple && currentGoal > 0 && daysRemaining < missedUnits;

  // Check if user already checked in today
  const hasCheckedInToday = myCurrentWeekData.checks.some((c) =>
    isSameBerlinDay(new Date(c.timestamp), now)
  );

  const handleToggleCircle = async (circleIndex: number) => {
    // Check if week is locked (e.g. past week)
    if (myCurrentWeekData.lockedAt) {
      onError('Diese Woche ist abgeschlossen und kann nicht mehr geändert werden.');
      return;
    }

    const currentChecks = [...myCurrentWeekData.checks];

    if (circleIndex < currentChecks.length) {
      // Removing the checkmark (undo)
      currentChecks.splice(circleIndex, 1);
      const updated: UserWeekData = {
        ...myCurrentWeekData,
        checks: currentChecks,
      };
      await onUpdateMyWeekData(currentWeekKey, updated);
      onSuccess('Einheit zurückgenommen.');
    } else if (circleIndex === currentChecks.length) {
      // Adding new checkmark
      if (!allowMultiple && hasCheckedInToday) {
        onError('Für heute bereits eingetragen. (Maximal eine Einheit pro Tag)');
        return;
      }

      if (currentChecks.length >= currentGoal) {
        onError('Du hast dein Trainingsziel für diese Woche bereits erreicht!');
        return;
      }

      const newCheck: WorkoutCheck = {
        timestamp: new Date().toISOString(),
      };
      currentChecks.push(newCheck);

      const updated: UserWeekData = {
        ...myCurrentWeekData,
        checks: currentChecks,
      };

      await onUpdateMyWeekData(currentWeekKey, updated);

      // Trigger celebration confetti if goal reached
      if (currentChecks.length === currentGoal && currentGoal > 0) {
        confetti({
          particleCount: 80,
          spread: 70,
          origin: { y: 0.6 },
        });
        onSuccess('Glückwunsch! Ziel für diese Woche erreicht! 🎉');
      } else {
        onSuccess('Einheit abgehakt! Stark gemacht! 💪');
      }
    }
  };

  const handleSaveCurrentGoal = async (newGoal: number) => {
    if (isAfterMonday && newGoal < myCurrentWeekData.goal) {
      onError('Ab Dienstag kann das Wochenziel nur noch erhöht, nicht mehr gesenkt werden.');
      return;
    }

    const updated: UserWeekData = {
      ...myCurrentWeekData,
      goal: newGoal,
      penaltyCentsSnapshot: myCurrentWeekData.penaltyCentsSnapshot || currentPenaltyCents,
    };

    await onUpdateMyWeekData(currentWeekKey, updated);
    setIsEditingGoal(false);
    onSuccess(`Wochenziel auf ${newGoal} ${newGoal === 1 ? 'Einheit' : 'Einheiten'} aktualisiert.`);
  };

  const handleSaveNextWeekGoal = async (newGoal: number) => {
    const updated: UserWeekData = {
      goal: newGoal,
      checks: myNextWeekData?.checks || [],
      penaltyCentsSnapshot: currentPenaltyCents,
    };
    await onUpdateMyWeekData(nextWeekKey, updated);
    onSuccess(`Ziel für nächste Woche (${nextWeekKey}) auf ${newGoal} Einheiten festgelegt.`);
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
          <div className="relative z-10 py-8 px-4 bg-white/5 border border-dashed border-white/10 rounded-2xl text-center flex flex-col items-center gap-2">
            <span className="text-3xl">🛋️</span>
            <p className="text-base font-black uppercase tracking-wider text-white">Diese Woche pausiert</p>
            <p className="text-xs text-white/50 max-w-xs leading-relaxed">
              Ziel ist auf 0 gesetzt. Du zahlst keine Strafe und erhältst keine Auszahlung.
            </p>
            {(isLateWindow || !isAfterMonday) && (
              <button
                type="button"
                id="start-training-now-btn"
                onClick={() => handleSaveCurrentGoal(3)}
                className="mt-3 px-6 py-3 bg-[#DFFF00] hover:scale-[1.02] active:scale-95 text-black font-black uppercase tracking-wider text-xs rounded-2xl shadow-lg cursor-pointer transition-transform"
              >
                Doch mittrainieren (Ziel setzen)
              </button>
            )}
          </div>
        ) : (
          <div className="relative z-10 flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 py-4">
              {Array.from({ length: currentGoal }).map((_, idx) => {
                const isChecked = idx < checksCount;
                const isNextToCheck = idx === checksCount;
                const checkData = isChecked ? myCurrentWeekData.checks[idx] : null;

                return (
                  <button
                    key={idx}
                    type="button"
                    id={`workout-circle-${idx}`}
                    aria-label={`Einheit ${idx + 1} von ${currentGoal}, ${isChecked ? 'erledigt' : 'nicht erledigt'}`}
                    onClick={() => handleToggleCircle(idx)}
                    className={`relative w-20 h-20 sm:w-22 sm:h-22 rounded-full flex flex-col items-center justify-center transition-all cursor-pointer select-none active:scale-95 ${
                      isChecked
                        ? 'border-4 border-[#DFFF00] bg-[#DFFF00] text-black shadow-lg shadow-[#DFFF00]/20'
                        : isNextToCheck
                        ? 'border-4 border-dashed border-[#DFFF00]/70 bg-white/5 hover:border-[#DFFF00] hover:bg-[#DFFF00]/10 text-white'
                        : 'border-4 border-dashed border-white/20 bg-white/5 text-white/30'
                    }`}
                  >
                    {isChecked ? (
                      <Check className="w-10 h-10 stroke-[3.5] text-black animate-in zoom-in-75 duration-200" />
                    ) : (
                      <span className="text-lg font-black font-mono">{idx + 1}</span>
                    )}

                    {isChecked && checkData && (
                      <span className="text-[9px] font-black font-mono text-black/80 -mt-1 tracking-tight">
                        {formatBerlinDate(checkData.timestamp)}
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

        {/* Goal Adjustment Controls */}
        <div className="relative z-10 pt-2 border-t border-white/10">
          {!isEditingGoal ? (
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/60">
                Wochenziel: <strong className="text-white font-black">{currentGoal} Einheiten</strong>
                {isAfterMonday && ' (Nur noch Erhöhung möglich)'}
              </span>
              <button
                type="button"
                id="edit-current-goal-btn"
                onClick={() => {
                  setSelectedGoal(currentGoal);
                  setIsEditingGoal(true);
                }}
                className="text-xs font-black uppercase tracking-wider text-[#DFFF00] hover:underline underline-offset-4 py-1 px-2 cursor-pointer"
              >
                Ziel anpassen
              </button>
            </div>
          ) : (
            <div className="p-4 bg-black/50 border border-white/10 rounded-2xl flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-white/70">Laufendes Ziel:</span>
                <span className="text-xl font-black text-[#DFFF00] font-mono">{selectedGoal}</span>
              </div>

              <div className="flex items-center justify-center gap-3">
                <button
                  type="button"
                  id="goal-minus-btn"
                  disabled={isAfterMonday && selectedGoal <= currentGoal}
                  onClick={() => setSelectedGoal((prev) => Math.max(0, prev - 1))}
                  className="w-11 h-11 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-20 disabled:cursor-not-allowed text-white flex items-center justify-center text-lg font-bold"
                >
                  <Minus className="w-5 h-5" />
                </button>

                <div className="flex gap-1.5">
                  {[1, 2, 3, 4, 5].map((num) => (
                    <button
                      key={num}
                      type="button"
                      disabled={isAfterMonday && num < currentGoal}
                      onClick={() => setSelectedGoal(num)}
                      className={`w-9 h-11 rounded-xl text-xs font-black font-mono transition-colors ${
                        selectedGoal === num
                          ? 'bg-[#DFFF00] text-black'
                          : 'bg-white/5 hover:bg-white/10 text-white/70 disabled:opacity-20'
                      }`}
                    >
                      {num}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  id="goal-plus-btn"
                  disabled={selectedGoal >= 14}
                  onClick={() => setSelectedGoal((prev) => Math.min(14, prev + 1))}
                  className="w-11 h-11 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-20 disabled:cursor-not-allowed text-white flex items-center justify-center text-lg font-bold"
                >
                  <Plus className="w-5 h-5" />
                </button>
              </div>

              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => setIsEditingGoal(false)}
                  className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-white/40 hover:text-white"
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  id="save-current-goal-btn"
                  onClick={() => handleSaveCurrentGoal(selectedGoal)}
                  className="px-5 py-2 bg-[#DFFF00] hover:scale-[1.02] text-black text-xs font-black uppercase tracking-wider rounded-xl shadow-md transition-transform cursor-pointer"
                >
                  Speichern
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* PROMINENT NEXT WEEK PLANNING CALLOUT (Sat/Sun/Mon) */}
      {(isPlanning || isLateWindow) && (
        <div
          id="planning-window-card"
          className="bg-white/5 border-2 border-[#DFFF00]/40 rounded-3xl p-6 shadow-xl flex flex-col gap-4 relative overflow-hidden"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-[#DFFF00]" />
              <h3 className="text-base font-black uppercase tracking-tight text-white">Nächste Woche planen</h3>
            </div>
            <span className="text-xs font-mono font-bold text-[#DFFF00] uppercase tracking-wider">KW {nextWeekKey.replace('2026-W', '')}</span>
          </div>

          <p className="text-xs text-white/60 leading-relaxed">
            Planungsfenster geöffnet ({nextWeekRange.fullRange}). Lege fest, wie oft du nächste Woche trainieren wirst.
          </p>

          <div className="flex items-center justify-between bg-black/40 p-3 rounded-2xl border border-white/10">
            <span className="text-xs uppercase tracking-wider text-white/50 font-bold">Einheiten:</span>

            <div className="flex items-center gap-2">
              <button
                type="button"
                id="next-week-goal-minus"
                onClick={() => setNextWeekGoal((g) => Math.max(0, g - 1))}
                className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center justify-center font-bold"
              >
                <Minus className="w-4 h-4" />
              </button>

              <span className="w-8 text-center text-xl font-black text-[#DFFF00] font-mono">
                {nextWeekGoal}
              </span>

              <button
                type="button"
                id="next-week-goal-plus"
                onClick={() => setNextWeekGoal((g) => Math.min(14, g + 1))}
                className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center justify-center font-bold"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>

            <button
              type="button"
              id="save-next-week-goal-btn"
              onClick={() => handleSaveNextWeekGoal(nextWeekGoal)}
              className="px-5 py-2.5 bg-[#DFFF00] hover:scale-[1.02] text-black font-black text-xs uppercase tracking-wider rounded-xl shadow-md cursor-pointer transition-transform"
            >
              Festlegen
            </button>
          </div>
        </div>
      )}

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
              const isSuccess = goal > 0 && completed >= goal;

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
                        {goal === 0 ? 'Pausiert' : `${completed} / ${goal} Einheiten`} • {formatEuro(member.penaltyCents)}
                      </span>
                    </div>
                  </div>

                  {/* Mini Circles Indicator */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {goal > 0 ? (
                      <div className="flex items-center gap-1">
                        {Array.from({ length: Math.min(goal, 7) }).map((_, cIdx) => (
                          <span
                            key={cIdx}
                            className={`w-4 h-4 rounded-full flex items-center justify-center text-[8px] ${
                              cIdx < completed
                                ? 'bg-[#DFFF00] text-black font-black'
                                : 'bg-white/5 border border-white/20'
                            }`}
                          />
                        ))}
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
      </div>
    </div>
  );
};
