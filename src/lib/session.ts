/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Login-session persistence.
 *
 * IMPORTANT distinction (per requirements):
 *  - The database (server key-value store) is the single source of truth for
 *    users, groups and memberships.
 *  - This module only persists a *pointer* to the currently logged-in account
 *    (which permanent user_id / username is signed in on THIS device) plus an
 *    expiry. It is a supporting convenience so the browser can auto-recognise a
 *    returning user without a fresh login. It never stores group or training
 *    data. If it is missing/expired/cleared, no user data is lost — the user
 *    simply logs in again and everything is re-loaded from the database.
 */

import { UserProfile } from '../types.ts';

const SESSION_KEY = 'tz_gym_login_session_v1';
// How long a persisted login session stays valid without re-authenticating.
const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

export interface PersistedLoginSession {
  userId: string;
  usernameLower: string;
  displayName: string;
  loginAt: string; // ISO
  expiresAt: string; // ISO
}

/** Generate a permanent, collision-resistant user id. */
export function generateUserId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      // RFC4122-ish v4 formatting
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  } catch (_e) {
    // fall through to non-crypto fallback
  }
  return `uid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Ensure a loaded profile carries a permanent id. Returns the (possibly
 * updated) profile and whether it changed, so the caller can persist the
 * migration back to the database exactly once.
 */
export function ensureUserId(profile: UserProfile): { profile: UserProfile; changed: boolean } {
  if (profile.id && typeof profile.id === 'string') {
    return { profile, changed: false };
  }
  return { profile: { ...profile, id: generateUserId() }, changed: true };
}

/** Persist the login-session pointer on this device (supporting only, not source of truth). */
export function saveLoginSession(profile: UserProfile, usernameLower: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const now = Date.now();
    const record: PersistedLoginSession = {
      userId: profile.id,
      usernameLower,
      displayName: profile.displayName,
      loginAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    };
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(record));
  } catch (_e) {
    // localStorage may be unavailable (private mode) — auto-login just won't work.
  }
}

/** Read a still-valid login-session pointer, or null if absent/expired/corrupt. */
export function readLoginSession(): PersistedLoginSession | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as PersistedLoginSession;
    if (!record || !record.usernameLower) return null;
    if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) {
      clearLoginSession();
      return null;
    }
    return record;
  } catch (_e) {
    return null;
  }
}

/** Clear the persisted login session (logout, or invalid restore). */
export function clearLoginSession(): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.removeItem(SESSION_KEY);
  } catch (_e) {
    // ignore
  }
}
