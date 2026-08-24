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

const LOCAL_STORAGE_PREFIX = 'tz_gym_storage_';
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

function listLocalFallback(prefix = ''): string[] {
  const keys = new Set<string>();
  Object.keys(clientFallbackMap).forEach((k) => {
    if (k.startsWith(prefix)) keys.add(k);
  });
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      for (let i = 0; i < window.localStorage.length; i++) {
        const fullKey = window.localStorage.key(i);
        if (fullKey && fullKey.startsWith(LOCAL_STORAGE_PREFIX)) {
          const rawKey = fullKey.slice(LOCAL_STORAGE_PREFIX.length);
          if (rawKey.startsWith(prefix)) {
            keys.add(rawKey);
          }
        }
      }
    }
  } catch (_e) {}
  return Array.from(keys);
}

// Ensure window.storage is initialized with shared backend support
export function initWindowStoragePolyfill() {
  if (typeof window === 'undefined') return;

  // If window.storage is not provided by host platform, mount our network-backed shared implementation
  if (!window.storage) {
    window.storage = {
      async get(key: string, _shared = true): Promise<string> {
        try {
          const res = await fetch(`/api/storage/get?key=${encodeURIComponent(key)}`);
          if (!res.ok) {
            const fallback = getLocalFallback(key);
            if (fallback !== null) return fallback;
            throw new Error(`Key not found: ${key}`);
          }
          const data = await res.json();
          if (data && typeof data.value === 'string') {
            setLocalFallback(key, data.value);
            return data.value;
          }
          const fallback = getLocalFallback(key);
          if (fallback !== null) return fallback;
          throw new Error(`Key not found: ${key}`);
        } catch (err: any) {
          const fallback = getLocalFallback(key);
          if (fallback !== null) return fallback;
          throw new Error(err?.message || `Key not found: ${key}`);
        }
      },

      async set(key: string, value: string, _shared = true): Promise<void> {
        setLocalFallback(key, value);
        try {
          const res = await fetch('/api/storage/set', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, value }),
          });
          if (!res.ok) {
            console.warn(`Server returned status ${res.status} for key:`, key);
          }
        } catch (err: any) {
          console.warn('Network sync warning for set:', key, err);
        }
      },

      async list(prefix = '', _shared = true): Promise<string[]> {
        const localKeys = listLocalFallback(prefix);
        try {
          const res = await fetch(`/api/storage/list?prefix=${encodeURIComponent(prefix)}`);
          if (!res.ok) {
            return localKeys;
          }
          const data = await res.json();
          const serverKeys: string[] = data.keys || [];
          const combined = Array.from(new Set([...serverKeys, ...localKeys]));
          return combined;
        } catch (_err: any) {
          return localKeys;
        }
      },

      async delete(key: string, _shared = true): Promise<void> {
        deleteLocalFallback(key);
        try {
          const res = await fetch(`/api/storage/delete?key=${encodeURIComponent(key)}`, {
            method: 'DELETE',
          });
          if (!res.ok && res.status !== 404) {
            console.warn(`Delete warning: ${key}`);
          }
        } catch (err: any) {
          console.warn('Network sync warning for delete:', key, err);
        }
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
