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

/** Build a map of userLower -> approved excused count for settlement inputs. */
export function excusedByUser(exceptions: ExceptionRequest[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const e of exceptions) {
    if (e.status === 'approved') {
      const u = e.requester.toLowerCase();
      map[u] = (map[u] || 0) + 1;
    }
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
