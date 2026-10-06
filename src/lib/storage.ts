/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Interface for window.storage as mandated by specification
declare global {
  interface Window {
    storage?: {
      get: (key: string, shared?: boolean) => Promise<string>;
      set: (key: string, value: string, shared?: boolean) => Promise<void>;
      list: (prefix?: string, shared?: boolean) => Promise<string[]>;
      delete: (key: string, shared?: boolean) => Promise<void>;
    };
  }
}

/*
 * Source of truth: the server store. localStorage holds a mirror of every value
 * this browser has read or written. That mirror is used for two things only:
 *  1. reading while the server is unreachable, and
 *  2. SELF-HEALING: if the server lost its data (non-durable store restarted),
 *     the mirror is uploaded and the server inserts whatever it is missing —
 *     never overwriting newer server data and never resurrecting deleted keys.
 */

const LOCAL_STORAGE_PREFIX = 'tz_gym_storage_';
const META_EPOCH = 'tz_gym_meta_restored_epoch';
const META_RESTORED_AT = 'tz_gym_meta_restored_at';
const DURABLE_RESYNC_MS = 24 * 60 * 60 * 1000;
const clientFallbackMap: Record<string, string> = {};

// Local storage helper
function getLocalFallback(key: string): string | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const item = window.localStorage.getItem(LOCAL_STORAGE_PREFIX + key);
      if (item !== null) return item;
    }
  } catch (_e) {}
  return Object.prototype.hasOwnProperty.call(clientFallbackMap, key) ? clientFallbackMap[key] : null;
}

function setLocalFallback(key: string, value: string) {
  clientFallbackMap[key] = value;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(LOCAL_STORAGE_PREFIX + key, value);
    }
  } catch (_e) {}
}

function deleteLocalFallback(key: string) {
  delete clientFallbackMap[key];
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(LOCAL_STORAGE_PREFIX + key);
    }
  } catch (_e) {}
}

/** Every cached key/value (in-memory map + localStorage). */
function allLocalEntries(prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(clientFallbackMap)) if (k.startsWith(prefix)) out[k] = v;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      for (let i = 0; i < window.localStorage.length; i++) {
        const fullKey = window.localStorage.key(i);
        if (!fullKey || !fullKey.startsWith(LOCAL_STORAGE_PREFIX)) continue;
        const rawKey = fullKey.slice(LOCAL_STORAGE_PREFIX.length);
        if (!rawKey.startsWith(prefix)) continue;
        const v = window.localStorage.getItem(fullKey);
        if (v !== null) out[rawKey] = v;
      }
    }
  } catch (_e) {}
  return out;
}

function readMeta(key: string): string | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage.getItem(key) : null;
  } catch (_e) {
    return null;
  }
}
function writeMeta(key: string, value: string) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(key, value);
  } catch (_e) {}
}

// ---------------------------------------------------------------------------
// Server reset detection & self-healing
// ---------------------------------------------------------------------------

let rehydrating: Promise<number> | null = null;

/** Upload the local mirror; the server inserts only what it is missing. */
export async function rehydrateServerFromCache(epoch?: string | null): Promise<number> {
  if (rehydrating) return rehydrating;
  rehydrating = (async () => {
    const entries = allLocalEntries();
    if (Object.keys(entries).length === 0) return 0;
    try {
      const res = await fetch('/api/storage/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      });
      if (!res.ok) return 0;
      const data = await res.json();
      const usedEpoch = epoch ?? res.headers.get('X-Store-Epoch');
      if (usedEpoch) writeMeta(META_EPOCH, usedEpoch);
      writeMeta(META_RESTORED_AT, String(Date.now()));
      return Number(data?.restored) || 0;
    } catch (_e) {
      return 0;
    }
  })();
  try {
    return await rehydrating;
  } finally {
    rehydrating = null;
  }
}

const attemptedEpochs = new Set<string>();

/**
 * fetch() for storage calls. If the response comes from a NON-durable store
 * instance this browser has not restored yet (i.e. the server was reset), the
 * local mirror is uploaded first. Concurrent callers share that one upload.
 * Reads are then retried once so callers see the recovered data instead of
 * "not found". Writes are NOT retried: their first response is already
 * correct, and restore never overwrites what they wrote.
 */
async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  const epoch = res.headers.get('X-Store-Epoch');
  const durable = res.headers.get('X-Store-Durable') === '1';
  if (epoch && !durable && readMeta(META_EPOCH) !== epoch) {
    if (rehydrating || !attemptedEpochs.has(epoch)) {
      attemptedEpochs.add(epoch);
      const restored = await rehydrateServerFromCache(epoch);
      const isRead = !init || !init.method || init.method.toUpperCase() === 'GET';
      if (restored > 0 && isRead) return fetch(url, init);
    }
  }
  return res;
}

export interface StorageHealth {
  backend: 'file' | 'firestore' | 'host';
  durable: boolean;
  startedAt?: string;
  warning?: string;
}

/**
 * Called once at startup, BEFORE any login lookup: makes sure the server holds
 * at least what this browser knows, so a reset server can never cause a
 * "new" account or an empty group list. Bounded by a timeout so a hanging
 * server cannot block the app.
 */
export async function ensureServerHydrated(timeoutMs = 8000): Promise<StorageHealth | null> {
  if (typeof window === 'undefined') return null;
  const run = async (): Promise<StorageHealth | null> => {
    try {
      const res = await fetch('/api/storage/health');
      if (!res.ok) return null;
      const h = (await res.json()) as StorageHealth;
      const lastEpoch = readMeta(META_EPOCH);
      const lastAt = Number(readMeta(META_RESTORED_AT) || 0);
      const needed = h.durable
        ? Date.now() - lastAt > DURABLE_RESYNC_MS // periodic safety net / one-time migration
        : lastEpoch !== h.startedAt; // a non-durable store restarted -> restore now
      if (needed) await rehydrateServerFromCache(h.startedAt);
      return h;
    } catch (_e) {
      return null;
    }
  };
  return Promise.race([
    run(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

// ---------------------------------------------------------------------------
// window.storage polyfill
// ---------------------------------------------------------------------------

class NotFoundError extends Error {}

// Ensure window.storage is initialized with shared backend support
export function initWindowStoragePolyfill() {
  if (typeof window === 'undefined') return;

  // If window.storage is not provided by host platform, mount our network-backed shared implementation
  if (!window.storage) {
    window.storage = {
      async get(key: string, _shared = true): Promise<string> {
        let res: Response;
        try {
          res = await apiFetch(`/api/storage/get?key=${encodeURIComponent(key)}`);
        } catch (_err) {
          // Offline: serve the last known value.
          const fallback = getLocalFallback(key);
          if (fallback !== null) return fallback;
          throw new Error(`Key not found: ${key}`);
        }
        if (res.status === 404) {
          // The server is authoritative: a 404 means the key does not exist.
          // (The local mirror is kept for self-healing, but not served.)
          throw new NotFoundError(`Key not found: ${key}`);
        }
        if (!res.ok) {
          const fallback = getLocalFallback(key);
          if (fallback !== null) return fallback;
          throw new Error(`Server error ${res.status} for key: ${key}`);
        }
        const data = await res.json();
        if (data && typeof data.value === 'string') {
          setLocalFallback(key, data.value);
          return data.value;
        }
        throw new NotFoundError(`Key not found: ${key}`);
      },

      async set(key: string, value: string, _shared = true): Promise<void> {
        // The server store is the single source of truth. We only mirror to
        // localStorage AFTER the server confirms the write, so the local cache
        // can never diverge from the database. If the server write fails we
        // surface the error (instead of silently keeping a local-only copy)
        // so the caller knows the data did NOT persist and can retry.
        try {
          const res = await apiFetch('/api/storage/set', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, value }),
          });
          if (!res.ok) {
            throw new Error(`Server returned status ${res.status} for key: ${key}`);
          }
        } catch (err: any) {
          throw new Error(err?.message || `Konnte "${key}" nicht in der Datenbank speichern.`);
        }
        // Confirmed persisted -> update supporting read cache.
        setLocalFallback(key, value);
      },

      async list(prefix = '', _shared = true): Promise<string[]> {
        try {
          const res = await apiFetch(`/api/storage/list?prefix=${encodeURIComponent(prefix)}`);
          if (res.ok) {
            const data = await res.json();
            return Array.isArray(data.keys) ? data.keys : [];
          }
        } catch (_err) {
          // fall through to offline listing
        }
        return Object.keys(allLocalEntries(prefix));
      },

      async delete(key: string, _shared = true): Promise<void> {
        const res = await apiFetch(`/api/storage/delete?key=${encodeURIComponent(key)}`, {
          method: 'DELETE',
        });
        if (!res.ok && res.status !== 404) {
          throw new Error(`Delete failed (${res.status}) for key: ${key}`);
        }
        deleteLocalFallback(key);
      },
    };
  }
}

// Auto-run polyfill initialization
initWindowStoragePolyfill();

/**
 * Robust helper functions wrapping window.storage with JSON parsing and strict error handling
 */
export async function storageGet<T>(key: string): Promise<T | null> {
  if (!window.storage) {
    initWindowStoragePolyfill();
  }
  try {
    const raw = await window.storage!.get(key, true);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (_e) {
    // Specification: Non-existent keys throw an error, they don't return null. We catch and return null for safe caller consumption.
    return null;
  }
}

export async function storageSet<T>(key: string, value: T): Promise<boolean> {
  if (!window.storage) {
    initWindowStoragePolyfill();
  }
  try {
    const payload = JSON.stringify(value);
    await window.storage!.set(key, payload, true);
    return true;
  } catch (err) {
    console.error(`Storage save failed for key "${key}":`, err);
    throw new Error('Konnte nicht gespeichert werden, bitte erneut versuchen.');
  }
}

/**
 * Create-only write. Returns true if this call created the key, false if it
 * already existed (someone else won the race). Throws if nothing persisted.
 */
export async function storageSetIfAbsent<T>(key: string, value: T): Promise<boolean> {
  const payload = JSON.stringify(value);
  let res: Response | null = null;
  try {
    res = await apiFetch('/api/storage/set-if-absent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value: payload }),
    });
  } catch (_e) {
    res = null;
  }
  if (res && res.ok) {
    const data = await res.json();
    if (data.created) setLocalFallback(key, payload);
    return !!data.created;
  }
  if (res && res.status !== 404) throw new Error('Konnte nicht gespeichert werden, bitte erneut versuchen.');
  // Endpoint unavailable (host-provided window.storage): best effort.
  if ((await storageGet<T>(key)) !== null) return false;
  await storageSet(key, value);
  return true;
}

export async function storageList(prefix: string): Promise<string[]> {
  if (!window.storage) {
    initWindowStoragePolyfill();
  }
  try {
    const list = await window.storage!.list(prefix, true);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.error(`Storage list failed for prefix "${prefix}":`, err);
    return [];
  }
}

/**
 * Batch read: load every key/value under one or more prefixes. Uses the
 * server's single /api/storage/entries request when available (one round trip
 * instead of dozens), and transparently falls back to list+get when the host
 * provides its own window.storage or the endpoint is unavailable.
 */
export async function storageGetMany(
  prefix: string | string[],
  suffix = ''
): Promise<Record<string, any>> {
  const prefixes = Array.isArray(prefix) ? prefix : [prefix];
  const out: Record<string, any> = {};

  try {
    const qs = prefixes.map((p) => `prefix=${encodeURIComponent(p)}`).join('&');
    const url = `/api/storage/entries?${qs}` + (suffix ? `&suffix=${encodeURIComponent(suffix)}` : '');
    const res = await apiFetch(url);
    if (res.ok) {
      const data = await res.json();
      const entries = data && data.entries;
      if (entries && typeof entries === 'object') {
        for (const [k, raw] of Object.entries(entries as Record<string, string>)) {
          if (typeof raw !== 'string') continue;
          try {
            out[k] = JSON.parse(raw);
            // Keep the supporting cache in sync, but only write when the value
            // actually changed: a poll otherwise rewrites the whole subtree to
            // localStorage (synchronous and needlessly slow) every time.
            if (clientFallbackMap[k] !== raw) setLocalFallback(k, raw);
          } catch (_e) {
            // skip unparsable entries
          }
        }
        return out;
      }
    }
  } catch (_e) {
    // fall through to the portable path below
  }

  // Fallback: enumerate then read individually (host-provided window.storage / offline).
  for (const p of prefixes) {
    const keys = (await storageList(p)).filter((k) => !suffix || k.endsWith(suffix));
    for (const k of keys) {
      const v = await storageGet<any>(k);
      if (v !== null) out[k] = v;
    }
  }
  return out;
}

export async function storageDelete(key: string): Promise<boolean> {
  if (!window.storage) {
    initWindowStoragePolyfill();
  }
  try {
    await window.storage!.delete(key, true);
    return true;
  } catch (err) {
    console.error(`Storage delete failed for key "${key}":`, err);
    return false;
  }
}
