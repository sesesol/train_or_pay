/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface UserProfile {
  id: string; // Permanent, immutable user id (UUID). Never changes, even across devices/logins.
  displayName: string;
  pinHash: string | null;
  createdAt: string;
  sessions: string[]; // List of session codes
}

export interface SessionMember {
  user: string; // Lowercase username identifier (stable join key, unique per account)
  userId?: string; // Permanent user id of the member (mirrors UserProfile.id). Backfilled for legacy data.
  displayName: string;
  joinedAt: string;
  penaltyCents: number; // Penalty per missed workout in cents (e.g. 500 = 5.00 €)
  active: boolean;
}

export interface SessionSettings {
  allowMultiplePerDay: boolean;
}

export interface SessionMeta {
  code: string; // 6-character code
  name: string;
  createdAt: string;
  adminUser: string; // Lowercase username of admin
  members: SessionMember[];
  settings: SessionSettings;
}

export interface WorkoutCheck {
  timestamp: string; // ISO string
  exercises?: {
    name: string;
    sets?: number;
    reps?: number;
    weightKg?: number;
  }[];
}

export interface UserWeekData {
  goal: number; // 0 to 14
  checks: WorkoutCheck[]; // Checked workout items
  penaltyCentsSnapshot: number; // Snapshot of penalty at start of week
  lockedAt?: string;
  joinedMidWeek?: boolean; // If true, member joined mid-week and paused
}

export interface SettlementEntry {
  from: string; // Lowercase username
  to: string; // Lowercase username
  amountCents: number;
  weekKey: string;
}

export interface WeekSettlement {
  settledAt: string;
  weekKey: string;
  entries: SettlementEntry[];
  summaryMessage?: string;
  memberBreakdown: {
    user: string;
    goal: number;
    completed: number;
    penaltyCents: number;
    missed: number;
    debtCents: number;
    isReceiver: boolean;
  }[];
}

export type DebtStatus = 'open' | 'pending_confirmation' | 'paid';

export interface DebtItem {
  id: string;
  from: string;
  to: string;
  amountCents: number;
  weekKey: string;
  status: DebtStatus;
  createdAt: string;
  paidAt?: string;
  markedPaidByDebtorAt?: string;
}

export interface DebtsStorage {
  open: DebtItem[];
  history: DebtItem[];
}

export interface NettedDebt {
  otherUser: string;
  netCents: number; // Positive means user is owed by otherUser, negative means user owes otherUser
  items: DebtItem[];
}

export interface WeekTimeInfo {
  currentWeekKey: string; // e.g. "2026-W12"
  nextWeekKey: string; // e.g. "2026-W13"
  isPlanningWindow: boolean; // Saturday 00:00 to Sunday 23:59
  isLateWindow: boolean; // Monday 00:00 to 23:59
  isWeekLocked: boolean; // Past Sunday
  dayOfWeek: number; // 1 = Monday, ..., 7 = Sunday
  dayName: string;
  daysRemainingInWeek: number;
  formattedDateBerlin: string;
  currentDateBerlinISO: string;
}
