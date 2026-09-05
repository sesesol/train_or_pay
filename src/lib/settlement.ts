/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SettlementEntry, WeekSettlement, UserWeekData, SessionMember, DebtItem, NettedDebt } from '../types.ts';

export function formatEuro(cents: number): string {
  const euro = Math.abs(cents) / 100;
  const formatted = euro.toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${cents < 0 ? '-' : ''}${formatted} €`;
}

export function parseEuroToCents(euroStr: string | number): number {
  if (typeof euroStr === 'number') {
    return Math.round(euroStr * 100);
  }
  const clean = euroStr.replace('€', '').trim().replace(/\s/g, '').replace(',', '.');
  const val = parseFloat(clean);
  if (isNaN(val)) return 0;
  return Math.round(val * 100);
}

export interface MemberWeekInput {
  user: string;
  displayName: string;
  goal: number;
  completed: number;
  penaltyCents: number;
  joinedMidWeek?: boolean;
  excused?: number; // number of approved exception ("Entschuldigt") units this week
}

/**
 * Deterministic settlement calculation strictly adhering to Section 7.2 & 7.3
 */
export function calculateWeekSettlement(
  weekKey: string,
  membersData: MemberWeekInput[]
): WeekSettlement {
  const breakdown = membersData.map((m) => {
    // If goal is 0 or joined mid-week with paused status
    const effectiveGoal = m.joinedMidWeek ? 0 : Math.max(0, m.goal);
    const completed = Math.min(m.completed, effectiveGoal); // only up to goal counts
    // Approved exceptions excuse open units: they count as neither done nor
    // missed, so they never trigger a penalty. Capped at the remaining open
    // units so they can never make "missed" negative or affect receiver status.
    const excused = Math.min(Math.max(0, m.excused || 0), Math.max(0, effectiveGoal - completed));
    const missed = Math.max(0, effectiveGoal - completed - excused);
    const penaltyRate = m.penaltyCents;
    const debtCents = missed * penaltyRate;
    // Being a receiver still requires actually reaching the goal by training;
    // an excused week neither pays nor receives.
    const isReceiver = effectiveGoal > 0 && m.completed >= effectiveGoal;

    return {
      user: m.user.toLowerCase(),
      goal: effectiveGoal,
      completed: m.completed,
      penaltyCents: penaltyRate,
      missed,
      excused,
      debtCents,
      isReceiver,
    };
  });

  const debtors = breakdown.filter((b) => b.debtCents > 0);
  // Sort receivers deterministically by lowercase username
  const receivers = breakdown
    .filter((b) => b.isReceiver)
    .sort((a, b) => a.user.localeCompare(b.user));

  const entries: SettlementEntry[] = [];
  let summaryMessage = '';

  const activeParticipants = breakdown.filter((b) => b.goal > 0);

  if (activeParticipants.length === 0) {
    summaryMessage = 'Keine aktiven Teilnehmer in dieser Woche.';
  } else if (activeParticipants.length === 1) {
    summaryMessage = 'Nur ein aktiver Teilnehmer — keine Abrechnung möglich.';
  } else if (receivers.length === 0) {
    summaryMessage = 'Diese Woche hat es niemand geschafft — keine Strafen.';
  } else if (debtors.length === 0) {
    summaryMessage = 'Alle haben es geschafft! 🎉';
  } else {
    // Split each individual debtor's debt equally among receivers
    for (const debtor of debtors) {
      const numReceivers = receivers.length;
      if (numReceivers === 0) continue;

      const totalCent = debtor.debtCents;
      const basis = Math.floor(totalCent / numReceivers);
      const remainder = totalCent % numReceivers;

      // Distribute remainder cent-by-cent deterministically
      for (let i = 0; i < numReceivers; i++) {
        const receiver = receivers[i];
        if (receiver.user === debtor.user) continue; // safety check

        const centAmount = basis + (i < remainder ? 1 : 0);
        if (centAmount > 0) {
          entries.push({
            from: debtor.user,
            to: receiver.user,
            amountCents: centAmount,
            weekKey,
          });
        }
      }
    }
  }

  return {
    settledAt: new Date().toISOString(),
    weekKey,
    entries,
    summaryMessage,
    memberBreakdown: breakdown,
  };
}

/**
 * Calculates net balances between all pairs of users (Section 8)
 */
export function calculateNettedDebts(currentUser: string, openDebts: DebtItem[]): NettedDebt[] {
  const currentLower = currentUser.toLowerCase();
  // Map of otherUser -> balance in cents (positive = otherUser owes current, negative = current owes otherUser)
  const balanceMap: Record<string, { netCents: number; items: DebtItem[] }> = {};

  for (const item of openDebts) {
    if (item.status === 'paid') continue;

    const fromLower = item.from.toLowerCase();
    const toLower = item.to.toLowerCase();

    if (fromLower === currentLower) {
      // Current user owes 'to'
      if (!balanceMap[toLower]) balanceMap[toLower] = { netCents: 0, items: [] };
      balanceMap[toLower].netCents -= item.amountCents;
      balanceMap[toLower].items.push(item);
    } else if (toLower === currentLower) {
      // 'from' owes current user
      if (!balanceMap[fromLower]) balanceMap[fromLower] = { netCents: 0, items: [] };
      balanceMap[fromLower].netCents += item.amountCents;
      balanceMap[fromLower].items.push(item);
    }
  }

  const result: NettedDebt[] = [];
  for (const [otherUser, data] of Object.entries(balanceMap)) {
    if (data.netCents !== 0 || data.items.some((i) => i.status === 'pending_confirmation')) {
      result.push({
        otherUser,
        netCents: data.netCents,
        items: data.items,
      });
    }
  }

  // Sort with highest amounts first
  return result.sort((a, b) => Math.abs(b.netCents) - Math.abs(a.netCents));
}

/**
 * Helper to check if a user has any open debt in the session
 */
export function hasUserOpenDebts(user: string, openDebts: DebtItem[]): boolean {
  const userLower = user.toLowerCase();
  return openDebts.some(
    (item) => item.status !== 'paid' && item.from.toLowerCase() === userLower && item.amountCents > 0
  );
}
