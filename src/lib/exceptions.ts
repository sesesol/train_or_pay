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

import { ExceptionRequest, ExceptionStatus, WorkoutCheck } from '../types.ts';
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
export type UnitState = { status: 'open' | 'done' | 'pending' | 'excused'; checkIndex?: number };

/** Resolve the exact units once for rendering, requests and settlement. */
export function getWeekUnits(goal: number, checks: WorkoutCheck[], exceptions: ExceptionRequest[], user: string): UnitState[] {
  const units: UnitState[] = Array.from({ length: Math.max(0, Math.min(14, Math.floor(goal || 0))) }, () => ({ status: 'open' }));
  const valid = (i: number) => Number.isInteger(i) && i >= 0 && i < units.length;
  // Explicit indices retain their positions when a different check is undone.
  checks.forEach((check, checkIndex) => {
    if (check.unitIndex !== undefined && valid(check.unitIndex) && units[check.unitIndex].status === 'open') units[check.unitIndex] = { status: 'done', checkIndex };
  });
  checks.forEach((check, checkIndex) => {
    if (check.unitIndex !== undefined) return;
    const index = units.findIndex(u => u.status === 'open');
    if (index >= 0) units[index] = { status: 'done', checkIndex };
  });
  const own = byRequester(exceptions, user);
  for (const status of ['approved', 'pending'] as const) {
    const targetStatus = status === 'approved' ? 'excused' : 'pending';
    const requests = own.filter(e => e.status === status);
    // New requests target fixed units. Never move an excuse onto a different day.
    for (const req of requests.filter(e => e.kind !== 'week' && e.unitIndices !== undefined)) {
      for (const index of new Set(req.unitIndices)) {
        if (valid(index) && units[index].status === 'open') units[index] = { status: targetStatus };
      }
    }
    // Legacy single requests remain one unit each, without interpreting slot as a unit index.
    for (const req of requests.filter(e => e.kind !== 'week' && e.unitIndices === undefined)) {
      const index = units.findIndex(u => u.status === 'open');
      if (index >= 0) units[index] = { status: targetStatus };
    }
    if (requests.some(e => e.kind === 'week')) {
      units.forEach((u, i) => { if (u.status === 'open') units[i] = { status: targetStatus }; });
    }
  }
  return units;
}

/** Reject stale selections rather than silently excusing different units. */
export function validateSelectedUnits(indices: number[], units: UnitState[]): number[] {
  const selected = [...new Set(indices)].sort((a, b) => a - b);
  if (!selected.length || selected.some(i => !Number.isInteger(i) || units[i]?.status !== 'open')) {
    throw new Error('Bitte offene Einheiten wählen. Bereits erledigte, angefragte oder entschuldigte Einheiten sind nicht auswählbar.');
  }
  return selected;
}

export function exceptionUnitLabel(request: ExceptionRequest): string {
  if (request.kind === 'week') return 'Restliche Woche';
  if (!request.unitIndices?.length) return 'Eine Einheit';
  return `${request.unitIndices.length === 1 ? 'Einheit' : 'Einheiten'} ${request.unitIndices.map(i => i + 1).join(', ')}`;
}

export function computeExcusedFor(
  exceptions: ExceptionRequest[], userLower: string, goal: number, completed: number,
  checks?: WorkoutCheck[]
): number {
  const workouts = checks ?? Array.from({ length: completed }, () => ({ timestamp: '' }));
  return getWeekUnits(goal, workouts, exceptions, userLower).filter(u => u.status === 'excused').length;
}

export function buildExcusedMap(
  exceptions: ExceptionRequest[],
  weekDataByUser: Record<string, { goal?: number; checks?: WorkoutCheck[] } | undefined>
): Record<string, number> {
  return Object.fromEntries(Object.entries(weekDataByUser).map(([user, data]) => [
    user, computeExcusedFor(exceptions, user, data?.goal || 0, data?.checks?.length || 0, data?.checks || []),
  ]));
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
