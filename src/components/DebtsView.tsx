/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  DollarSign,
  ArrowUpRight,
  ArrowDownLeft,
  CheckCircle2,
  Clock,
  Send,
  AlertCircle,
  Copy,
  Check,
  CreditCard,
  Calculator,
  PlusCircle,
  Sparkles,
  Users,
  Layers,
} from 'lucide-react';
import { DebtItem, SessionMeta, UserProfile, UserWeekData, WeekSettlement } from '../types.ts';
import { formatEuro, parseEuroToCents, calculateWeekSettlement } from '../lib/settlement.ts';
import { formatBerlinDateTime } from '../lib/time.ts';

interface DebtsViewProps {
  session: SessionMeta;
  currentUser: UserProfile;
  usernameLower: string;
  openDebts: DebtItem[];
  paymentHistory: DebtItem[];
  currentWeekKey?: string;
  allMembersCurrentWeek?: Record<string, UserWeekData>;
  onUpdateDebts: (updatedOpen: DebtItem[], updatedHistory: DebtItem[]) => Promise<void>;
  onRunKassenabschluss?: (weekKey?: string) => Promise<WeekSettlement>;
  onRecordDirectPayment?: (fromUser: string, toUser: string, amountCents: number, memo?: string) => Promise<void>;
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
}

export const DebtsView: React.FC<DebtsViewProps> = ({
  session,
  currentUser,
  usernameLower,
  openDebts,
  paymentHistory,
  currentWeekKey = '2026-W12',
  allMembersCurrentWeek = {},
  onUpdateDebts,
  onRunKassenabschluss,
  onRecordDirectPayment,
  onError,
  onSuccess,
}) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [partialPayModalItem, setPartialPayModalItem] = useState<DebtItem | null>(null);
  const [partialPayInput, setPartialPayInput] = useState<string>('');

  // Modals for Kassenabschluss & Direct Payment
  const [showKassenabschlussModal, setShowKassenabschlussModal] = useState<boolean>(false);
  const [isExecutingKassenabschluss, setIsExecutingKassenabschluss] = useState<boolean>(false);

  const [showDirectPayModal, setShowDirectPayModal] = useState<boolean>(false);
  const [directPayFrom, setDirectPayFrom] = useState<string>(usernameLower);
  const [directPayTo, setDirectPayTo] = useState<string>('');
  const [directPayEuro, setDirectPayEuro] = useState<string>('5.00');
  const [directPayMemo, setDirectPayMemo] = useState<string>('Ausgleich');
  const [isSubmittingDirectPay, setIsSubmittingDirectPay] = useState<boolean>(false);

  // Find display name helper
  const getDisplayName = (userLower: string): string => {
    const member = session.members.find((m) => m.user.toLowerCase() === userLower.toLowerCase());
    return member ? member.displayName : userLower;
  };

  // Active members
  const activeMembers = session.members.filter((m) => m.active);

  // Compute live preview of Kassenabschluss for current week
  const liveMemberInputs = activeMembers.map((m) => {
    const mLower = m.user.toLowerCase();
    const uData = allMembersCurrentWeek[mLower];
    return {
      user: mLower,
      displayName: m.displayName,
      goal: uData ? uData.goal : 3,
      completed: uData ? (uData.checks?.length || 0) : 0,
      penaltyCents: uData?.penaltyCentsSnapshot || m.penaltyCents,
      joinedMidWeek: uData?.joinedMidWeek || false,
    };
  });
  const liveSettlementPreview = calculateWeekSettlement(currentWeekKey, liveMemberInputs);
  const liveTotalPenaltyPot = liveSettlementPreview.memberBreakdown.reduce((sum, b) => sum + b.debtCents, 0);

  // Group and compute net balances per pair of users
  const peerMap: Record<string, { netCents: number; items: DebtItem[] }> = {};

  for (const item of openDebts) {
    if (item.status === 'paid') continue;
    const from = item.from.toLowerCase();
    const to = item.to.toLowerCase();

    if (from === usernameLower) {
      // I owe 'to'
      if (!peerMap[to]) peerMap[to] = { netCents: 0, items: [] };
      peerMap[to].netCents -= item.amountCents;
      peerMap[to].items.push(item);
    } else if (to === usernameLower) {
      // 'from' owes me
      if (!peerMap[from]) peerMap[from] = { netCents: 0, items: [] };
      peerMap[from].netCents += item.amountCents;
      peerMap[from].items.push(item);
    }
  }

  // Calculate totals
  let totalIOwe = 0;
  let totalOwedToMe = 0;

  for (const [_user, data] of Object.entries(peerMap)) {
    if (data.netCents < 0) {
      totalIOwe += Math.abs(data.netCents);
    } else if (data.netCents > 0) {
      totalOwedToMe += data.netCents;
    }
  }

  // Action: Debtor marks "Habe bezahlt"
  const handleMarkAsPaidByDebtor = async (item: DebtItem) => {
    const updatedOpen = openDebts.map((d) => {
      if (d.id === item.id) {
        return {
          ...d,
          status: 'pending_confirmation' as const,
          markedPaidByDebtorAt: new Date().toISOString(),
        };
      }
      return d;
    });

    await onUpdateDebts(updatedOpen, paymentHistory);
    onSuccess('Als bezahlt markiert. Empfänger muss die Zahlung jetzt bestätigen.');
  };

  // Action: Receiver confirms payment received
  const handleConfirmPaidByReceiver = async (item: DebtItem) => {
    const paidItem: DebtItem = {
      ...item,
      status: 'paid',
      paidAt: new Date().toISOString(),
    };

    const updatedOpen = openDebts.filter((d) => d.id !== item.id);
    const updatedHistory = [paidItem, ...paymentHistory];

    await onUpdateDebts(updatedOpen, updatedHistory);
    onSuccess(`Zahlung von ${formatEuro(item.amountCents)} als beglichen bestätigt!`);
  };

  // Action: Settle all items with a peer
  const handleSettleAllWithPeer = async (otherUserLower: string) => {
    const peerItems = openDebts.filter(
      (d) =>
        d.status !== 'paid' &&
        ((d.from.toLowerCase() === usernameLower && d.to.toLowerCase() === otherUserLower) ||
          (d.to.toLowerCase() === usernameLower && d.from.toLowerCase() === otherUserLower))
    );

    if (peerItems.length === 0) return;

    const settledAt = new Date().toISOString();
    const paidItems: DebtItem[] = peerItems.map((item) => ({
      ...item,
      status: 'paid',
      paidAt: settledAt,
    }));

    const remainingOpen = openDebts.filter((d) => !peerItems.some((pi) => pi.id === d.id));
    const updatedHistory = [...paidItems, ...paymentHistory];

    await onUpdateDebts(remainingOpen, updatedHistory);
    onSuccess(`Alle offenen Salden mit ${getDisplayName(otherUserLower)} als bezahlt verbucht!`);
  };

  // Action: Partial payment
  const handlePartialPayment = async () => {
    if (!partialPayModalItem) return;
    const partialCents = parseEuroToCents(partialPayInput);

    if (partialCents <= 0) {
      onError('Bitte einen gültigen Betrag größer als 0,00 € eingeben.');
      return;
    }

    if (partialCents > partialPayModalItem.amountCents) {
      onError('Der Teilbetrag kann nicht höher als die Gesamtschuld sein.');
      return;
    }

    const isFull = partialCents === partialPayModalItem.amountCents;

    if (isFull) {
      await handleConfirmPaidByReceiver(partialPayModalItem);
      setPartialPayModalItem(null);
      return;
    }

    const paidRecord: DebtItem = {
      id: `${partialPayModalItem.id}-part-${Date.now()}`,
      from: partialPayModalItem.from,
      to: partialPayModalItem.to,
      amountCents: partialCents,
      weekKey: partialPayModalItem.weekKey,
      status: 'paid',
      createdAt: partialPayModalItem.createdAt,
      paidAt: new Date().toISOString(),
    };

    const remainingItem: DebtItem = {
      ...partialPayModalItem,
      amountCents: partialPayModalItem.amountCents - partialCents,
      status: 'open',
    };

    const updatedOpen = openDebts.map((d) => (d.id === partialPayModalItem.id ? remainingItem : d));
    const updatedHistory = [paidRecord, ...paymentHistory];

    await onUpdateDebts(updatedOpen, updatedHistory);
    setPartialPayModalItem(null);
    onSuccess(`Teilzahlung über ${formatEuro(partialCents)} verbucht. Rest: ${formatEuro(remainingItem.amountCents)}`);
  };

  // Action: Execute Kassenabschluss on demand
  const handleExecuteKassenabschluss = async () => {
    if (!onRunKassenabschluss) return;
    setIsExecutingKassenabschluss(true);
    try {
      await onRunKassenabschluss(currentWeekKey);
      setShowKassenabschlussModal(false);
      onSuccess(`Kassenabschluss für KW ${currentWeekKey.replace('2026-W', '')} erfolgreich ausgeführt!`);
    } catch (e: any) {
      onError('Fehler beim Kassenabschluss: ' + (e?.message || ''));
    } finally {
      setIsExecutingKassenabschluss(false);
    }
  };

  // Action: Submit Direct Payment
  const handleSubmitDirectPayment = async () => {
    if (!onRecordDirectPayment) return;
    const cents = parseEuroToCents(directPayEuro);
    if (cents <= 0) {
      onError('Bitte einen Betrag größer als 0,00 € eingeben.');
      return;
    }
    if (!directPayTo) {
      onError('Bitte wähle einen Empfänger aus.');
      return;
    }
    if (directPayFrom.toLowerCase() === directPayTo.toLowerCase()) {
      onError('Absender und Empfänger dürfen nicht identisch sein.');
      return;
    }

    setIsSubmittingDirectPay(true);
    try {
      await onRecordDirectPayment(directPayFrom, directPayTo, cents, directPayMemo);
      setShowDirectPayModal(false);
      onSuccess(`Zahlung von ${formatEuro(cents)} an ${getDisplayName(directPayTo)} verbucht!`);
    } catch (e: any) {
      onError('Fehler beim Speichern der Zahlung: ' + (e?.message || ''));
    } finally {
      setIsSubmittingDirectPay(false);
    }
  };

  const handleCopyMemo = (otherName: string, amountCents: number) => {
    const text = `Gym-Strafe „${session.name}“: ${formatEuro(amountCents)} an ${otherName}`;
    navigator.clipboard.writeText(text);
    setCopiedId(otherName);
    setTimeout(() => setCopiedId(null), 2000);
    onSuccess('Zahlungstext kopiert!');
  };

  const peersList = Object.entries(peerMap).filter(
    ([_, data]) => data.netCents !== 0 || data.items.length > 0
  );

  return (
    <div className="flex flex-col gap-6 pb-12 animate-in fade-in duration-200">
      {/* Top Totals Overview */}
      <div className="grid grid-cols-2 gap-3">
        <div
          id="total-i-owe-card"
          className="bg-red-500/10 border border-red-500/20 rounded-3xl p-5 shadow-xl flex flex-col gap-1"
        >
          <div className="flex items-center gap-1.5 text-red-400 text-xs font-black uppercase tracking-[0.2em]">
            <ArrowUpRight className="w-4 h-4 stroke-[3]" />
            <span>Ich schulde</span>
          </div>
          <span className="text-3xl sm:text-4xl font-black text-red-400 font-mono mt-1">
            {formatEuro(totalIOwe)}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-red-400/60 font-bold">Gesamt an andere</span>
        </div>

        <div
          id="total-owed-to-me-card"
          className="bg-[#DFFF00]/10 border border-[#DFFF00]/20 rounded-3xl p-5 shadow-xl flex flex-col gap-1"
        >
          <div className="flex items-center gap-1.5 text-[#DFFF00] text-xs font-black uppercase tracking-[0.2em]">
            <ArrowDownLeft className="w-4 h-4 stroke-[3]" />
            <span>Mir geschuldet</span>
          </div>
          <span className="text-3xl sm:text-4xl font-black text-[#DFFF00] font-mono mt-1">
            {formatEuro(totalOwedToMe)}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-[#DFFF00]/60 font-bold">Von anderen offen</span>
        </div>
      </div>

      {/* QUICK ACTIONS BAR: Kassenabschluss & Direktzahlung */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          type="button"
          id="open-kassenabschluss-btn"
          onClick={() => setShowKassenabschlussModal(true)}
          className="p-4 bg-white/5 hover:bg-white/10 active:scale-98 border border-white/15 hover:border-[#DFFF00]/50 rounded-2xl flex items-center justify-between text-left transition-all cursor-pointer shadow-lg group"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#DFFF00]/15 text-[#DFFF00] flex items-center justify-center group-hover:bg-[#DFFF00] group-hover:text-black transition-colors">
              <Calculator className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div className="flex flex-col">
              <span className="text-xs font-black uppercase tracking-wider text-white">Kassenabschluss</span>
              <span className="text-[11px] text-white/50">Abrechnung & Kassensturz</span>
            </div>
          </div>
          <span className="text-[11px] font-mono font-bold text-[#DFFF00] bg-[#DFFF00]/10 px-2.5 py-1 rounded-lg border border-[#DFFF00]/20">
            KW {currentWeekKey.replace('2026-W', '')}
          </span>
        </button>

        <button
          type="button"
          id="open-direct-pay-btn"
          onClick={() => {
            const firstOther = activeMembers.find((m) => m.user.toLowerCase() !== usernameLower);
            if (firstOther) setDirectPayTo(firstOther.user.toLowerCase());
            setShowDirectPayModal(true);
          }}
          className="p-4 bg-white/5 hover:bg-white/10 active:scale-98 border border-white/15 hover:border-[#DFFF00]/50 rounded-2xl flex items-center justify-between text-left transition-all cursor-pointer shadow-lg group"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#DFFF00]/15 text-[#DFFF00] flex items-center justify-center group-hover:bg-[#DFFF00] group-hover:text-black transition-colors">
              <Send className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div className="flex flex-col">
              <span className="text-xs font-black uppercase tracking-wider text-white">Zahlung erfassen</span>
              <span className="text-[11px] text-white/50">Jederzeit direkt begleichen</span>
            </div>
          </div>
          <span className="text-[11px] font-mono font-bold text-white/70 bg-white/10 px-2.5 py-1 rounded-lg">
            Direkt-Ausgleich
          </span>
        </button>
      </div>

      {/* Saldo-Verrechnung List (Section 8) */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs uppercase tracking-[0.2em] text-white/40 font-bold flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-[#DFFF00]" />
            Verrechnete Salden ({peersList.length})
          </h3>
        </div>

        {peersList.length === 0 ? (
          <div className="py-10 bg-white/5 border border-white/10 rounded-3xl text-center flex flex-col items-center gap-3 p-6">
            <div className="w-12 h-12 rounded-2xl bg-[#DFFF00] flex items-center justify-center text-black font-black">
              <CheckCircle2 className="w-6 h-6 stroke-[3]" />
            </div>
            <p className="text-base font-black uppercase tracking-wider text-white">Alles ausgeglichen!</p>
            <p className="text-xs text-white/50 max-w-xs leading-relaxed">
              Es gibt aktuell keine offenen Schulden oder Forderungen in dieser Session. Du kannst jederzeit Zahlungen oder Zwischenabrechnungen durchführen.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {peersList.map(([otherUserLower, data]) => {
              const otherName = getDisplayName(otherUserLower);
              const iOweOther = data.netCents < 0;
              const otherOwesMe = data.netCents > 0;
              const absAmount = Math.abs(data.netCents);

              return (
                <div
                  key={otherUserLower}
                  id={`debt-card-${otherUserLower}`}
                  className={`p-5 rounded-3xl border flex flex-col gap-4 transition-all shadow-xl ${
                    iOweOther
                      ? 'bg-red-500/5 border-red-500/20'
                      : 'bg-white/5 border-white/10'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-col">
                      <span className="text-[10px] uppercase tracking-[0.2em] text-white/40 font-bold">
                        {iOweOther ? 'Du schuldest' : 'Schuldet dir'}
                      </span>
                      <h4 className="text-lg font-black uppercase tracking-tight text-white mt-0.5">{otherName}</h4>
                    </div>

                    <div className="flex flex-col items-end">
                      <span
                        className={`text-2xl sm:text-3xl font-black font-mono ${
                          iOweOther ? 'text-red-400' : 'text-[#DFFF00]'
                        }`}
                      >
                        {formatEuro(absAmount)}
                      </span>
                      <span className="text-[10px] uppercase tracking-wider text-white/40 font-bold mt-0.5">
                        {data.items.length} offene {data.items.length === 1 ? 'Woche' : 'Wochen'}
                      </span>
                    </div>
                  </div>

                  {/* Detailed items list for this person */}
                  <div className="space-y-2 pt-3 border-t border-white/10">
                    {data.items.map((item) => {
                      const itemIOwe = item.from.toLowerCase() === usernameLower;
                      const isPendingConfirmation = item.status === 'pending_confirmation';

                      return (
                        <div
                          key={item.id}
                          className="bg-black/40 p-3.5 rounded-2xl border border-white/10 flex items-center justify-between gap-2 text-xs"
                        >
                          <div className="flex flex-col min-w-0">
                            <span className="font-black text-white font-mono uppercase tracking-wider">
                              KW {item.weekKey.replace('2026-W', '')}
                            </span>
                            <span className="text-[11px] text-white/50 mt-0.5">
                              {itemIOwe ? 'Du zahlst an ' + otherName : otherName + ' zahlt an dich'}
                            </span>
                            {isPendingConfirmation && (
                              <span className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-[#DFFF00] bg-[#DFFF00]/10 px-2 py-0.5 rounded-md border border-[#DFFF00]/20 w-fit">
                                <Clock className="w-3 h-3" /> Bestätigung ausstehend
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <span className="font-black font-mono text-base text-white">
                              {formatEuro(item.amountCents)}
                            </span>

                            {/* Action Buttons */}
                            {itemIOwe ? (
                              isPendingConfirmation ? (
                                <span className="text-[10px] text-white/40 uppercase tracking-wider font-bold italic">
                                  Warten...
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  id={`mark-paid-debtor-${item.id}`}
                                  onClick={() => handleMarkAsPaidByDebtor(item)}
                                  className="px-3 py-2 bg-[#DFFF00] hover:scale-[1.02] active:scale-95 text-black rounded-xl text-xs font-black uppercase tracking-wider flex items-center gap-1.5 cursor-pointer shadow-md transition-transform"
                                >
                                  <Send className="w-3.5 h-3.5" /> Bezahlt
                                </button>
                              )
                            ) : (
                              <div className="flex gap-1.5">
                                <button
                                  type="button"
                                  id={`confirm-paid-receiver-${item.id}`}
                                  onClick={() => handleConfirmPaidByReceiver(item)}
                                  className="px-3 py-2 bg-[#DFFF00] hover:scale-[1.02] text-black rounded-xl text-xs font-black uppercase tracking-wider flex items-center gap-1.5 cursor-pointer shadow-md transition-transform"
                                >
                                  <Check className="w-3.5 h-3.5 stroke-[3]" /> Bestätigen
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPartialPayModalItem(item);
                                    setPartialPayInput((item.amountCents / 100).toFixed(2));
                                  }}
                                  className="px-2.5 py-2 bg-white/10 hover:bg-white/20 text-white rounded-xl text-xs font-black uppercase tracking-wider cursor-pointer"
                                >
                                  Teil
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Actions footer for this peer */}
                  <div className="flex items-center justify-between flex-wrap gap-2 pt-2 border-t border-white/5">
                    {iOweOther && (
                      <button
                        type="button"
                        onClick={() => handleCopyMemo(otherName, absAmount)}
                        className="text-xs text-white/50 hover:text-[#DFFF00] flex items-center gap-1.5 cursor-pointer font-medium uppercase tracking-wider transition-colors"
                      >
                        {copiedId === otherName ? (
                          <Check className="w-3.5 h-3.5 text-[#DFFF00]" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        <span>Zahlungs-Betreff kopieren</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleSettleAllWithPeer(otherUserLower)}
                      className="ml-auto text-xs font-black uppercase tracking-wider text-[#DFFF00] hover:underline underline-offset-4 cursor-pointer py-1 px-2"
                    >
                      Alle Schulden mit {otherName} begleichen
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Payment History Archive */}
      {paymentHistory.length > 0 && (
        <div className="flex flex-col gap-3 pt-4 border-t border-white/10">
          <h3 className="text-xs uppercase tracking-[0.2em] text-white/40 font-bold">
            Zahlungsverlauf ({paymentHistory.length})
          </h3>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {paymentHistory.map((item) => (
              <div
                key={item.id}
                className="bg-white/5 border border-white/10 p-3.5 rounded-2xl flex items-center justify-between text-xs text-white/80"
              >
                <div className="flex flex-col">
                  <span>
                    <strong className="text-white font-black">{getDisplayName(item.from)}</strong> →{' '}
                    <strong className="text-white font-black">{getDisplayName(item.to)}</strong>
                  </span>
                  <span className="text-[10px] text-white/40 font-mono mt-0.5 uppercase tracking-wider">
                    {item.paidAt ? formatBerlinDateTime(item.paidAt) : 'Beglichen'} • KW {item.weekKey.replace('2026-W', '')}
                  </span>
                </div>
                <span className="font-black text-[#DFFF00] font-mono">
                  {formatEuro(item.amountCents)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Mandatory Disclaimer (Section 8) */}
      <div className="p-4 bg-white/5 border border-white/10 rounded-2xl flex items-start gap-3 text-xs text-white/60">
        <CreditCard className="w-4 h-4 text-[#DFFF00] shrink-0 mt-0.5" />
        <p className="leading-relaxed">
          <strong className="text-white font-black uppercase tracking-wider">Hinweis:</strong> Die Überweisung passiert außerhalb der App (z. B. via PayPal, Revolut oder Bar). Die App verwaltet den Schuldenstand und berechnet deterministisch die Ausgleiche.
        </p>
      </div>

      {/* ======================================================== */}
      {/* MODAL 1: KASSENABSCHLUSS & LIVE-ABRECHNUNG */}
      {/* ======================================================== */}
      {showKassenabschlussModal && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0A0A0A] border border-white/20 rounded-3xl p-6 w-full max-w-lg flex flex-col gap-4 text-white shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-2">
                <Calculator className="w-5 h-5 text-[#DFFF00]" />
                <h3 className="font-black text-lg uppercase tracking-tight">Kassenabschluss durchführen</h3>
              </div>
              <span className="text-xs font-mono font-black text-[#DFFF00] bg-[#DFFF00]/10 px-2.5 py-1 rounded-lg border border-[#DFFF00]/20">
                KW {currentWeekKey.replace('2026-W', '')}
              </span>
            </div>

            <p className="text-xs text-white/60 leading-relaxed">
              Hier wird der aktuelle Trainingsstand abgerechnet: Wer sein Wochenziel verfehlt hat, zahlt die festgesetzte Strafe gleichmäßig an alle, die ihr Ziel erreicht haben.
            </p>

            {/* Live member overview for settlement */}
            <div className="flex flex-col gap-2">
              <span className="text-[10px] uppercase tracking-[0.2em] text-white/40 font-bold">
                Stand der aktuellen Woche
              </span>
              <div className="space-y-1.5">
                {liveSettlementPreview.memberBreakdown.map((mb) => {
                  const isSuccess = mb.goal > 0 && mb.completed >= mb.goal;
                  const isZero = mb.goal === 0;

                  return (
                    <div
                      key={mb.user}
                      className="p-3 bg-white/5 border border-white/10 rounded-xl flex items-center justify-between text-xs"
                    >
                      <div className="flex flex-col">
                        <span className="font-black text-white uppercase tracking-tight">
                          {getDisplayName(mb.user)}
                        </span>
                        <span className="text-[10px] text-white/50 font-mono">
                          {isZero
                            ? 'Pausiert'
                            : `Ziel: ${mb.goal} | Erreicht: ${mb.completed} | Verpasst: ${mb.missed}`}
                        </span>
                      </div>

                      <div className="flex items-center gap-2 font-mono font-bold">
                        {isZero ? (
                          <span className="text-white/40 text-[11px]">0,00 €</span>
                        ) : isSuccess ? (
                          <span className="text-[#DFFF00] text-xs font-black flex items-center gap-1">
                            <Check className="w-3.5 h-3.5 stroke-[3]" /> Ziel erreicht
                          </span>
                        ) : (
                          <span className="text-red-400 text-xs font-black">
                            - {formatEuro(mb.debtCents)}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Calculated transfers */}
            <div className="p-4 bg-black/50 border border-white/10 rounded-2xl flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-white/70">Gesamter Straf-Topf:</span>
                <span className="text-lg font-black text-[#DFFF00] font-mono">
                  {formatEuro(liveTotalPenaltyPot)}
                </span>
              </div>

              {liveSettlementPreview.entries.length > 0 ? (
                <div className="space-y-1 mt-2 pt-2 border-t border-white/10">
                  <span className="text-[10px] uppercase tracking-wider text-white/40 block mb-1">
                    Verrechnungs-Transfers:
                  </span>
                  {liveSettlementPreview.entries.map((entry, idx) => (
                    <div key={idx} className="text-xs flex items-center justify-between text-white/80">
                      <span>
                        <strong className="text-white">{getDisplayName(entry.from)}</strong> zahlt an{' '}
                        <strong className="text-white">{getDisplayName(entry.to)}</strong>
                      </span>
                      <span className="font-mono font-black text-[#DFFF00]">
                        {formatEuro(entry.amountCents)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-white/50 italic mt-1">
                  {liveSettlementPreview.summaryMessage || 'Keine Zahlungen erforderlich.'}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-white/10">
              <button
                type="button"
                disabled={isExecutingKassenabschluss}
                onClick={() => setShowKassenabschlussModal(false)}
                className="px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-white/40 hover:text-white"
              >
                Schließen
              </button>
              <button
                type="button"
                id="confirm-kassenabschluss-btn"
                disabled={isExecutingKassenabschluss}
                onClick={handleExecuteKassenabschluss}
                className="px-5 py-2.5 bg-[#DFFF00] hover:scale-[1.02] text-black font-black text-xs uppercase tracking-wider rounded-xl shadow-lg cursor-pointer transition-transform flex items-center gap-1.5"
              >
                <Calculator className="w-4 h-4" />
                <span>{isExecutingKassenabschluss ? 'Verbuche...' : 'Kassenabschluss jetzt verbuchen'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* MODAL 2: DIREKTZAHLUNG ERFASSEN (JEDERZEIT ZAHLEN) */}
      {/* ======================================================== */}
      {showDirectPayModal && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0A0A0A] border border-white/20 rounded-3xl p-6 w-full max-w-sm flex flex-col gap-4 text-white shadow-2xl">
            <div className="flex items-center gap-2 pb-2 border-b border-white/10">
              <Send className="w-5 h-5 text-[#DFFF00]" />
              <h3 className="font-black text-lg uppercase tracking-tight">Zahlung erfassen</h3>
            </div>

            <div className="flex flex-col gap-3">
              {/* Payer */}
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-white/50 block mb-1 font-bold">
                  Wer zahlt? (Absender)
                </label>
                <select
                  value={directPayFrom}
                  onChange={(e) => setDirectPayFrom(e.target.value)}
                  className="w-full px-3 py-2.5 bg-white/5 border border-white/20 rounded-xl text-xs font-black uppercase tracking-wider text-white focus:outline-none focus:border-[#DFFF00]"
                >
                  {activeMembers.map((m) => (
                    <option key={m.user} value={m.user.toLowerCase()} className="bg-black text-white">
                      {m.displayName} {m.user.toLowerCase() === usernameLower && '(Du)'}
                    </option>
                  ))}
                </select>
              </div>

              {/* Receiver */}
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-white/50 block mb-1 font-bold">
                  An wen? (Empfänger)
                </label>
                <select
                  value={directPayTo}
                  onChange={(e) => setDirectPayTo(e.target.value)}
                  className="w-full px-3 py-2.5 bg-white/5 border border-white/20 rounded-xl text-xs font-black uppercase tracking-wider text-white focus:outline-none focus:border-[#DFFF00]"
                >
                  <option value="" disabled className="bg-black text-white/40">
                    Empfänger auswählen...
                  </option>
                  {activeMembers
                    .filter((m) => m.user.toLowerCase() !== directPayFrom.toLowerCase())
                    .map((m) => (
                      <option key={m.user} value={m.user.toLowerCase()} className="bg-black text-white">
                        {m.displayName}
                      </option>
                    ))}
                </select>
              </div>

              {/* Amount */}
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-white/50 block mb-1 font-bold">
                  Betrag in €:
                </label>
                <input
                  type="number"
                  step="0.50"
                  min="0.50"
                  value={directPayEuro}
                  onChange={(e) => setDirectPayEuro(e.target.value)}
                  className="w-full px-4 py-3 bg-white/5 border border-white/20 rounded-xl font-mono text-2xl font-black text-[#DFFF00] focus:outline-none focus:border-[#DFFF00]"
                />

                {/* Fast amount chips */}
                <div className="flex gap-1.5 mt-2">
                  {[2, 5, 10, 15, 20].map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => setDirectPayEuro(amt.toFixed(2))}
                      className="px-2.5 py-1 bg-white/10 hover:bg-white/20 text-white rounded-lg text-xs font-mono font-bold cursor-pointer"
                    >
                      {amt} €
                    </button>
                  ))}
                </div>
              </div>

              {/* Note / Memo */}
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-white/50 block mb-1 font-bold">
                  Verwendungszweck (optional):
                </label>
                <input
                  type="text"
                  value={directPayMemo}
                  onChange={(e) => setDirectPayMemo(e.target.value)}
                  placeholder="z.B. Bar bezahlt, PayPal, Ausgleich"
                  className="w-full px-3 py-2 bg-white/5 border border-white/20 rounded-xl text-xs text-white focus:outline-none focus:border-[#DFFF00]"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-white/10">
              <button
                type="button"
                disabled={isSubmittingDirectPay}
                onClick={() => setShowDirectPayModal(false)}
                className="px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-white/40 hover:text-white"
              >
                Abbrechen
              </button>
              <button
                type="button"
                id="submit-direct-payment-btn"
                disabled={isSubmittingDirectPay}
                onClick={handleSubmitDirectPayment}
                className="px-5 py-2.5 bg-[#DFFF00] hover:scale-[1.02] text-black font-black text-xs uppercase tracking-wider rounded-xl shadow-lg cursor-pointer flex items-center gap-1.5"
              >
                <Check className="w-4 h-4 stroke-[3]" />
                <span>{isSubmittingDirectPay ? 'Verbucht...' : 'Zahlung jetzt verbuchen'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Partial Payment Modal */}
      {partialPayModalItem && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0A0A0A] border border-white/20 rounded-3xl p-6 w-full max-w-sm flex flex-col gap-4 text-white shadow-2xl">
            <h3 className="font-black text-lg uppercase tracking-tight">Teilzahlung verbuchen</h3>
            <p className="text-xs text-white/60">
              Gesamte offene Schuld: <strong className="text-[#DFFF00] font-mono font-black">{formatEuro(partialPayModalItem.amountCents)}</strong>
            </p>

            <div>
              <label className="text-xs uppercase tracking-wider text-white/50 block mb-1 font-bold">Erhaltener Betrag in €:</label>
              <input
                type="number"
                step="0.50"
                min="0.50"
                value={partialPayInput}
                onChange={(e) => setPartialPayInput(e.target.value)}
                className="w-full px-4 py-3 bg-white/5 border border-white/20 rounded-xl font-mono text-xl font-black text-white focus:outline-none focus:border-[#DFFF00]"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPartialPayModalItem(null)}
                className="px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-white/40 hover:text-white"
              >
                Abbrechen
              </button>
              <button
                type="button"
                onClick={handlePartialPayment}
                className="px-5 py-2.5 bg-[#DFFF00] hover:scale-[1.02] text-black font-black text-xs uppercase tracking-wider rounded-xl shadow-lg cursor-pointer"
              >
                Verbuchen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

