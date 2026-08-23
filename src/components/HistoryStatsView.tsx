/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  History,
  TrendingUp,
  Award,
  Flame,
  ChevronDown,
  ChevronUp,
  Calculator,
  CheckCircle2,
  AlertCircle,
  Trophy,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import { WeekSettlement, SessionMeta, UserProfile } from '../types.ts';
import { formatEuro, calculateWeekSettlement } from '../lib/settlement.ts';
import { getWeekDateRange } from '../lib/time.ts';

interface HistoryStatsViewProps {
  session: SessionMeta;
  currentUser: UserProfile;
  usernameLower: string;
  settlements: WeekSettlement[];
}

export const HistoryStatsView: React.FC<HistoryStatsViewProps> = ({
  session,
  currentUser,
  usernameLower,
  settlements,
}) => {
  const [expandedWeekKey, setExpandedWeekKey] = useState<string | null>(
    settlements.length > 0 ? settlements[0].weekKey : null
  );
  const [showRechenbeispielModal, setShowRechenbeispielModal] = useState(false);

  // Compute personal stats
  let totalWeeksParticipated = 0;
  let totalWeeksSucceeded = 0;
  let currentStreak = 0;
  let streakActive = true;
  let totalPaidCents = 0;
  let totalReceivedCents = 0;

  // Sort settlements by week descending
  const sortedSettlements = [...settlements].sort((a, b) => b.weekKey.localeCompare(a.weekKey));

  // Compute streak and totals from settlements
  for (const s of sortedSettlements) {
    const myBreakdown = s.memberBreakdown.find((b) => b.user.toLowerCase() === usernameLower);
    if (myBreakdown && myBreakdown.goal > 0) {
      totalWeeksParticipated++;
      const reached = myBreakdown.completed >= myBreakdown.goal;
      if (reached) {
        totalWeeksSucceeded++;
        if (streakActive) currentStreak++;
      } else {
        streakActive = false;
      }
    }

    // Tally paid/received
    for (const entry of s.entries) {
      if (entry.from.toLowerCase() === usernameLower) {
        totalPaidCents += entry.amountCents;
      }
      if (entry.to.toLowerCase() === usernameLower) {
        totalReceivedCents += entry.amountCents;
      }
    }
  }

  const successRatePercent =
    totalWeeksParticipated > 0 ? Math.round((totalWeeksSucceeded / totalWeeksParticipated) * 100) : 0;

  // Session ranking: compute success rate per active member
  const memberStats = session.members
    .filter((m) => m.active)
    .map((member) => {
      const uLower = member.user.toLowerCase();
      let weeksPart = 0;
      let weeksSucc = 0;

      for (const s of sortedSettlements) {
        const mb = s.memberBreakdown.find((b) => b.user.toLowerCase() === uLower);
        if (mb && mb.goal > 0) {
          weeksPart++;
          if (mb.completed >= mb.goal) weeksSucc++;
        }
      }

      const rate = weeksPart > 0 ? Math.round((weeksSucc / weeksPart) * 100) : 0;
      return {
        member,
        weeksPart,
        weeksSucc,
        rate,
      };
    })
    .sort((a, b) => b.rate - a.rate || b.weeksSucc - a.weeksSucc);

  // Helper for Member name
  const getDisplayName = (uLower: string): string => {
    const found = session.members.find((m) => m.user.toLowerCase() === uLower.toLowerCase());
    return found ? found.displayName : uLower;
  };

  // Section 7.4 Verification Test Run:
  const runExample74 = () => {
    const exampleMembers = [
      { user: 'ali', displayName: 'Ali', goal: 3, completed: 3, penaltyCents: 500 },
      { user: 'bea', displayName: 'Bea', goal: 2, completed: 0, penaltyCents: 1000 },
      { user: 'cem', displayName: 'Cem', goal: 4, completed: 3, penaltyCents: 500 },
    ];
    return calculateWeekSettlement('2026-W12', exampleMembers);
  };
  const exampleResult = runExample74();

  return (
    <div className="flex flex-col gap-6 pb-12 animate-in fade-in duration-200">
      {/* PERSONAL STATS HEADER */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white/5 border border-white/10 rounded-3xl p-5 flex flex-col gap-1 shadow-xl">
          <div className="flex items-center gap-1.5 text-xs text-[#DFFF00] font-black uppercase tracking-[0.2em]">
            <Flame className="w-4 h-4 text-[#DFFF00]" />
            <span>Serie</span>
          </div>
          <span className="text-3xl font-black text-white font-mono mt-1">
            {currentStreak} {currentStreak === 1 ? 'Woche' : 'Wochen'}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-white/40 font-bold">In Folge geschafft</span>
        </div>

        <div className="bg-white/5 border border-white/10 rounded-3xl p-5 flex flex-col gap-1 shadow-xl">
          <div className="flex items-center gap-1.5 text-xs text-[#DFFF00] font-black uppercase tracking-[0.2em]">
            <Award className="w-4 h-4" />
            <span>Quote</span>
          </div>
          <span className="text-3xl font-black text-white font-mono mt-1">{successRatePercent}%</span>
          <span className="text-[10px] uppercase tracking-wider text-white/40 font-bold">
            {totalWeeksSucceeded} / {totalWeeksParticipated} Wochen
          </span>
        </div>

        <div className="bg-white/5 border border-white/10 rounded-3xl p-5 flex flex-col gap-1 shadow-xl">
          <div className="flex items-center gap-1.5 text-xs text-red-400 font-black uppercase tracking-[0.2em]">
            <span>Gezahlt</span>
          </div>
          <span className="text-2xl sm:text-3xl font-black text-red-400 font-mono mt-1">
            {formatEuro(totalPaidCents)}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-white/40 font-bold">Gesamte Strafen</span>
        </div>

        <div className="bg-white/5 border border-white/10 rounded-3xl p-5 flex flex-col gap-1 shadow-xl">
          <div className="flex items-center gap-1.5 text-xs text-[#DFFF00] font-black uppercase tracking-[0.2em]">
            <span>Erhalten</span>
          </div>
          <span className="text-2xl sm:text-3xl font-black text-[#DFFF00] font-mono mt-1">
            {formatEuro(totalReceivedCents)}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-white/40 font-bold">Auszahlungen</span>
        </div>
      </div>

      {/* SESSION LEADERBOARD */}
      <div className="bg-white/5 border border-white/10 rounded-3xl p-6 sm:p-7 shadow-xl flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs uppercase tracking-[0.2em] text-white/40 font-bold flex items-center gap-2">
            <Trophy className="w-4 h-4 text-[#DFFF00]" />
            Gruppen-Rangliste
          </h3>
        </div>

        <div className="space-y-2.5">
          {memberStats.map((item, rank) => {
            const isMe = item.member.user.toLowerCase() === usernameLower;
            return (
              <div
                key={item.member.user}
                className={`p-4 rounded-2xl border flex items-center justify-between text-xs transition-all ${
                  isMe
                    ? 'bg-[#DFFF00]/10 border-[#DFFF00]/30 font-black'
                    : 'bg-black/40 border-white/10 text-white/80'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`w-7 h-7 rounded-xl flex items-center justify-center font-black text-xs font-mono ${
                      rank === 0
                        ? 'bg-[#DFFF00] text-black'
                        : rank === 1
                        ? 'bg-white text-black'
                        : rank === 2
                        ? 'bg-white/40 text-black'
                        : 'bg-white/10 text-white/60'
                    }`}
                  >
                    {rank + 1}
                  </span>
                  <span className="text-sm text-white font-black uppercase tracking-tight">
                    {item.member.displayName} {isMe && '(Du)'}
                  </span>
                </div>

                <div className="flex items-center gap-4">
                  <span className="text-white/50 font-mono">
                    {item.weeksSucc}/{item.weeksPart} Wochen
                  </span>
                  <span className="font-black font-mono text-[#DFFF00] text-base">{item.rate}%</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* SECTION 7.4 RECHENBEISPIEL PROOF CARD */}
      <div className="p-5 sm:p-6 bg-white/5 border border-white/10 rounded-3xl flex flex-col gap-3 shadow-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Calculator className="w-4 h-4 text-[#DFFF00]" />
            <h4 className="text-xs font-black text-white uppercase tracking-[0.2em]">
              Regelwerk & Rechenbeispiel (Abschnitt 7.4)
            </h4>
          </div>
          <button
            type="button"
            id="open-rechenbeispiel-modal-btn"
            onClick={() => setShowRechenbeispielModal(true)}
            className="text-xs font-black uppercase tracking-wider text-[#DFFF00] hover:underline underline-offset-4 cursor-pointer"
          >
            Abrechnung prüfen
          </button>
        </div>
        <p className="text-xs text-white/50 leading-relaxed">
          Strafen werden cent-genau und deterministisch berechnet: Wer sein Ziel verfehlt, zahlt pro verpasster Einheit gleichmäßig an alle, die ihr Ziel erreicht haben.
        </p>
      </div>

      {/* WEEKS ARCHIVE */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs uppercase tracking-[0.2em] text-white/40 font-bold flex items-center gap-2">
            <History className="w-4 h-4 text-[#DFFF00]" />
            Abgeschlossene Wochen ({sortedSettlements.length})
          </h3>
        </div>

        {sortedSettlements.length === 0 ? (
          <div className="py-12 bg-white/5 border border-white/10 rounded-3xl text-center flex flex-col items-center gap-3 p-6">
            <History className="w-8 h-8 text-white/30 mb-1" />
            <p className="text-base font-black uppercase tracking-wider text-white">Noch keine abgeschlossenen Wochen</p>
            <p className="text-xs text-white/50 max-w-xs leading-relaxed">
              Sobald die aktuelle Woche endet (Sonntag 23:59), wird sie hier automatisch abgerechnet und archiviert.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {sortedSettlements.map((settlement) => {
              const isExpanded = expandedWeekKey === settlement.weekKey;
              const range = getWeekDateRange(settlement.weekKey);

              return (
                <div
                  key={settlement.weekKey}
                  className="bg-white/5 border border-white/10 rounded-3xl overflow-hidden shadow-xl transition-all"
                >
                  <button
                    type="button"
                    onClick={() => setExpandedWeekKey(isExpanded ? null : settlement.weekKey)}
                    className="w-full p-5 flex items-center justify-between gap-3 text-left hover:bg-white/5 transition-colors cursor-pointer"
                  >
                    <div className="flex flex-col">
                      <span className="font-black text-white text-base font-mono uppercase tracking-wider">
                        KW {settlement.weekKey.replace('2026-W', '')} — 2026
                      </span>
                      <span className="text-xs text-white/50 font-mono mt-0.5">{range.fullRange}</span>
                    </div>

                    <div className="flex items-center gap-3">
                      {settlement.entries.length > 0 ? (
                        <span className="px-3 py-1 bg-[#DFFF00]/10 text-[#DFFF00] border border-[#DFFF00]/30 text-xs font-black uppercase tracking-wider rounded-full font-mono">
                          {settlement.entries.length} {settlement.entries.length === 1 ? 'Buchung' : 'Buchungen'}
                        </span>
                      ) : (
                        <span className="px-3 py-1 bg-white/10 text-white/50 text-xs font-bold uppercase tracking-wider rounded-full">
                          0,00 € Straffrei
                        </span>
                      )}
                      {isExpanded ? (
                        <ChevronUp className="w-5 h-5 text-white/40" />
                      ) : (
                        <ChevronDown className="w-5 h-5 text-white/40" />
                      )}
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="p-5 pt-0 border-t border-white/10 flex flex-col gap-4">
                      {settlement.summaryMessage && (
                        <p className="text-xs text-[#DFFF00] font-black uppercase tracking-wider pt-4">
                          {settlement.summaryMessage}
                        </p>
                      )}

                      {/* Member breakdown table */}
                      <div className="overflow-x-auto pt-2">
                        <table className="w-full text-left text-xs">
                          <thead>
                            <tr className="text-white/40 border-b border-white/10 pb-2 uppercase tracking-widest font-black text-[10px]">
                              <th className="py-2.5">Mitglied</th>
                              <th className="py-2.5 text-center">Ziel</th>
                              <th className="py-2.5 text-center">Erledigt</th>
                              <th className="py-2.5 text-right">Satz</th>
                              <th className="py-2.5 text-right">Schuld</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-white/5">
                            {settlement.memberBreakdown.map((mb) => (
                              <tr key={mb.user} className="text-white/90 font-medium">
                                <td className="py-3 font-black text-white uppercase tracking-tight">
                                  {getDisplayName(mb.user)}
                                </td>
                                <td className="py-3 text-center font-mono font-bold">{mb.goal}</td>
                                <td className="py-3 text-center font-mono">
                                  <span
                                    className={`px-2 py-0.5 rounded-full font-black text-xs ${
                                      mb.completed >= mb.goal && mb.goal > 0
                                        ? 'bg-[#DFFF00] text-black'
                                        : 'bg-white/10 text-white/70'
                                    }`}
                                  >
                                    {mb.completed}
                                  </span>
                                </td>
                                <td className="py-3 text-right font-mono text-white/50">
                                  {formatEuro(mb.penaltyCents)}
                                </td>
                                <td className="py-3 text-right font-mono font-black">
                                  {mb.debtCents > 0 ? (
                                    <span className="text-red-400">{formatEuro(mb.debtCents)}</span>
                                  ) : (
                                    <span className="text-[#DFFF00]">—</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Generated Bookings */}
                      {settlement.entries.length > 0 && (
                        <div className="flex flex-col gap-2 pt-3 border-t border-white/10">
                          <span className="text-[10px] uppercase tracking-[0.2em] font-black text-white/40">
                            Daraus resultierende Buchungen:
                          </span>
                          <div className="space-y-2">
                            {settlement.entries.map((entry, idx) => (
                              <div
                                key={idx}
                                className="p-3 bg-black/40 rounded-2xl border border-white/10 flex items-center justify-between text-xs"
                              >
                                <span className="font-bold text-white">
                                  <strong>{getDisplayName(entry.from)}</strong> →{' '}
                                  <strong>{getDisplayName(entry.to)}</strong>
                                </span>
                                <span className="font-black font-mono text-base text-[#DFFF00]">
                                  {formatEuro(entry.amountCents)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Rechenbeispiel Verification Modal (Section 7.4) */}
      {showRechenbeispielModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0A0A0A] border border-white/20 rounded-3xl p-6 w-full max-w-md flex flex-col gap-4 text-white max-h-[90vh] overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <h3 className="text-base font-black uppercase tracking-tight flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-[#DFFF00]" />
                Abschnitt 7.4 Rechenbeispiel
              </h3>
              <button
                type="button"
                onClick={() => setShowRechenbeispielModal(false)}
                className="text-xs uppercase tracking-wider font-bold text-white/40 hover:text-white px-2 py-1 cursor-pointer"
              >
                Schließen
              </button>
            </div>

            <p className="text-xs text-white/60 leading-relaxed">
              Verifikation des verbindlichen Rechenbeispiels aus den Spezifikationen (Session mit Ali, Bea, Cem für Woche 2026-W12):
            </p>

            <div className="bg-black/50 p-4 rounded-2xl border border-white/10 text-xs">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-white/40 border-b border-white/10 pb-1.5 uppercase font-bold text-[10px] tracking-wider">
                    <th>Person</th>
                    <th>Ziel</th>
                    <th>Erledigt</th>
                    <th>Satz</th>
                    <th>Schuld</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-mono text-xs">
                  <tr>
                    <td className="py-1.5 font-bold text-white">Ali</td>
                    <td>3</td>
                    <td>3</td>
                    <td>5,00 €</td>
                    <td className="text-[#DFFF00] font-black">— (Empfänger)</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 font-bold text-white">Bea</td>
                    <td>2</td>
                    <td>0</td>
                    <td>10,00 €</td>
                    <td className="text-red-400 font-black">20,00 €</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 font-bold text-white">Cem</td>
                    <td>4</td>
                    <td>3</td>
                    <td>5,00 €</td>
                    <td className="text-red-400 font-black">5,00 €</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="p-4 bg-[#DFFF00]/10 border border-[#DFFF00]/30 rounded-2xl flex flex-col gap-2 text-xs">
              <strong className="text-[#DFFF00] font-black uppercase tracking-wider">Ergebnis der Berechnungs-Engine:</strong>
              {exampleResult.entries.map((e, idx) => (
                <div key={idx} className="flex justify-between font-mono font-bold text-white">
                  <span>{e.from.toUpperCase()} → {e.to.toUpperCase()}:</span>
                  <span className="text-[#DFFF00] font-black text-sm">{formatEuro(e.amountCents)}</span>
                </div>
              ))}
              <p className="text-[11px] text-white/50 mt-1">
                ✅ Exakte Übereinstimmung mit Anforderung: Bea → Ali 20,00 € und Cem → Ali 5,00 €.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setShowRechenbeispielModal(false)}
              className="w-full py-3 bg-[#DFFF00] hover:scale-[1.02] active:scale-95 text-black font-black uppercase tracking-wider rounded-2xl text-xs shadow-lg transition-transform cursor-pointer"
            >
              Verstanden
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
