/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Exception ("Ausnahme") requests: a member asks to be excused for a single
 * planned unit of the CURRENT week; a partner must approve. Each request is
 * stored under its OWN key in the shared session so that:
 *  - both partners always load the same, database-backed state,
 *  - one member's request/decision never overwrites another member's progress
 *    or another request (per-key writes instead of one shared array), and
 *  - the deterministic key prevents duplicate requests for the same unit slot.
 *
 * Storage key: session:{code}:week:{weekKey}:exception:{requesterLower}:{slot}
 */

import { ExceptionRequest, ExceptionStatus } from '../types.ts';
import { storageGet, storageList } from './storage.ts';

export interface ExceptionReasonOption {
  code: string;
  label: string;
}

export const EXCEPTION_REASONS: ExceptionReasonOption[] = [
  { code: 'krank', label: 'Krank' },
  { code: 'reise', label: 'Reise' },
  { code: 'termin', label: 'Termin' },
  { code: 'verletzung', label: 'Verletzung' },
  { code: 'anderer', label: 'Anderer Grund' },
];

export function exceptionsPrefix(code: string, weekKey: string): string {
  return `session:${code}:week:${weekKey}:exception:`;
}

export function exceptionKey(
  code: string,
  weekKey: string,
  requesterLower: string,
  slot: number
): string {
  return `${exceptionsPrefix(code, weekKey)}${requesterLower}:${slot}`;
}

/** Load all exception requests for a given session week (both members' requests). */
export async function loadWeekExceptions(
  code: string,
  weekKey: string
): Promise<ExceptionRequest[]> {
  const keys = await storageList(exceptionsPrefix(code, weekKey));
  const out: ExceptionRequest[] = [];
  for (const k of keys) {
    const e = await storageGet<ExceptionRequest>(k);
    if (e && e.id) out.push(e);
  }
  // Deterministic order: oldest first.
  return out.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

function byRequester(exceptions: ExceptionRequest[], userLower: string): ExceptionRequest[] {
  const u = userLower.toLowerCase();
  return exceptions.filter((e) => e.requester.toLowerCase() === u);
}

/** Approved exceptions for a user in this week -> excused (penalty-free) units. */
export function countApprovedExcused(exceptions: ExceptionRequest[], userLower: string): number {
  return byRequester(exceptions, userLower).filter((e) => e.status === 'approved').length;
}

/** Pending + approved requests already consume open-unit capacity. */
export function countActiveExceptions(exceptions: ExceptionRequest[], userLower: string): number {
  return byRequester(exceptions, userLower).filter(
    (e) => e.status === 'pending' || e.status === 'approved'
  ).length;
}

/** True if the user has an emergency week dropout that is pending or approved. */
export function hasActiveWeekException(
  exceptions: ExceptionRequest[],
  userLower: string
): boolean {
  return byRequester(exceptions, userLower).some(
    (e) => e.kind === 'week' && (e.status === 'pending' || e.status === 'approved')
  );
}

/** True if an APPROVED emergency week dropout is in effect for the user. */
export function hasApprovedWeekException(
  exceptions: ExceptionRequest[],
  userLower: string
): boolean {
  return byRequester(exceptions, userLower).some(
    (e) => e.kind === 'week' && e.status === 'approved'
  );
}

/**
 * Excused units for one user in a week. An approved emergency dropout excuses
 * every remaining open unit; otherwise each approved single request excuses one
 * unit. Always capped at the units still open, so it can never over-credit.
 */
export function computeExcusedFor(
  exceptions: ExceptionRequest[],
  userLower: string,
  goal: number,
  completed: number
): number {
  const remaining = Math.max(0, (goal || 0) - (completed || 0));
  if (remaining === 0) return 0;
  if (hasApprovedWeekException(exceptions, userLower)) return remaining;
  return Math.min(countApprovedExcused(exceptions, userLower), remaining);
}

/**
 * Build userLower -> excused count for settlement inputs, given each member's
 * week data (goal/completed), which the week-wide dropout depends on.
 */
export function buildExcusedMap(
  exceptions: ExceptionRequest[],
  weekDataByUser: Record<string, { goal?: number; checks?: unknown[] } | undefined>
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const [user, data] of Object.entries(weekDataByUser)) {
    map[user] = computeExcusedFor(
      exceptions,
      user,
      data?.goal || 0,
      data?.checks?.length || 0
    );
  }
  return map;
}

/** Next free slot index for a requester (guarantees a unique, stable key). */
export function nextSlotForUser(exceptions: ExceptionRequest[], userLower: string): number {
  const slots = byRequester(exceptions, userLower).map((e) => e.slot);
  return slots.length ? Math.max(...slots) + 1 : 0;
}

export function statusLabel(status: ExceptionStatus): string {
  switch (status) {
    case 'approved':
      return 'Genehmigt';
    case 'rejected':
      return 'Abgelehnt';
    default:
      return 'Wartet auf Zustimmung';
  }
}
