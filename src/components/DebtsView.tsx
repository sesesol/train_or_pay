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
  Shield,
  HelpCircle,
} from 'lucide-react';
import { DebtItem, SessionMeta, UserProfile } from '../types.ts';
import { formatEuro, parseEuroToCents } from '../lib/settlement.ts';
import { formatBerlinDateTime } from '../lib/time.ts';
import { storageSet } from '../lib/storage.ts';

interface DebtsViewProps {
  session: SessionMeta;
  currentUser: UserProfile;
  usernameLower: string;
  openDebts: DebtItem[];
  paymentHistory: DebtItem[];
  onUpdateDebts: (updatedOpen: DebtItem[], updatedHistory: DebtItem[]) => Promise<void>;
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
}

export const DebtsView: React.FC<DebtsViewProps> = ({
  session,
  currentUser,
  usernameLower,
  openDebts,
  paymentHistory,
  onUpdateDebts,
  onError,
  onSuccess,
}) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [partialPayModalItem, setPartialPayModalItem] = useState<DebtItem | null>(null);
  const [partialPayInput, setPartialPayInput] = useState<string>('');

  // Find display name helper
  const getDisplayName = (userLower: string): string => {
    const member = session.members.find((m) => m.user.toLowerCase() === userLower.toLowerCase());
    return member ? member.displayName : userLower;
  };

  // Group and compute net balances per pair of users
  // Map of otherUserLower -> { netCents: number, items: DebtItem[] }
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

  // Action: Receiver confirms payment received (Full or direct)
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

    // Partial: record payment item in history, update open item with remaining amount
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

      {/* Saldo-Verrechnung List (Section 8) */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs uppercase tracking-[0.2em] text-white/40 font-bold flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-[#DFFF00]" />
            Verrechnete Salden ({peersList.length})
          </h3>
        </div>

        {peersList.length === 0 ? (
          <div className="py-12 bg-white/5 border border-white/10 rounded-3xl text-center flex flex-col items-center gap-3 p-6">
            <div className="w-12 h-12 rounded-2xl bg-[#DFFF00] flex items-center justify-center text-black font-black">
              <CheckCircle2 className="w-6 h-6 stroke-[3]" />
            </div>
            <p className="text-base font-black uppercase tracking-wider text-white">Alles ausgeglichen!</p>
            <p className="text-xs text-white/50 max-w-xs leading-relaxed">
              Es gibt aktuell keine offenen Schulden oder Forderungen in dieser Session.
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
                              // Debtor Actions
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
                              // Receiver Actions
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

                  {/* Copy Payment Memo Helper */}
                  {iOweOther && (
                    <button
                      type="button"
                      onClick={() => handleCopyMemo(otherName, absAmount)}
                      className="text-xs text-white/50 hover:text-[#DFFF00] flex items-center gap-1.5 pt-1 cursor-pointer font-medium uppercase tracking-wider transition-colors"
                    >
                      {copiedId === otherName ? (
                        <Check className="w-3.5 h-3.5 text-[#DFFF00]" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      <span>Zahlungs-Betreff kopieren</span>
                    </button>
                  )}
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
          <strong className="text-white font-black uppercase tracking-wider">Hinweis:</strong> Die Überweisung passiert außerhalb der App (z. B. via PayPal, Revolut oder Bar). Die App verwaltet nur den Schuldenstand.
        </p>
      </div>

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
