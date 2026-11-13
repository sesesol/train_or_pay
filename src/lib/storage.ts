import {
  firestoreGetRecord,
  firestoreSetRecord,
  subscribeFirestoreChanges,
  testConnection,
} from './firebase.ts';

let localMigrationPromise: Promise<void> | null = null;

/**
 * The server + Cloud Firestore are authoritative.
 * On browser startup, any legacy records cached in localStorage on this device
 * that are not yet in Cloud Firestore are automatically migrated to Firestore
 * so they become available across all devices.
 */
export function initWindowStoragePolyfill(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !window.localStorage) {
    return Promise.resolve();
  }
  if (localMigrationPromise) return localMigrationPromise;

  localMigrationPromise = (async () => {
    try {
      await testConnection();
    } catch (_e) {}

    try {
      const candidates: Array<{ key: string; raw: string }> = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (!k) continue;
        let targetKey: string | null = null;
        if (k.startsWith('tz_cache:')) {
          targetKey = k.slice('tz_cache:'.length);
        } else if (k.startsWith('session:') || k.startsWith('user:')) {
          targetKey = k;
        }
        if (targetKey) {
          const rawVal = window.localStorage.getItem(k);
          if (rawVal) {
            candidates.push({ key: targetKey, raw: rawVal });
          }
        }
      }

      for (const { key, raw } of candidates) {
        try {
          const existingCloud = await firestoreGetRecord(key);
          if (existingCloud === undefined) {
            await firestoreSetRecord(key, raw);
            await fetch('/api/storage/set', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key, value: raw }),
            }).catch(() => {});
          }
        } catch (_e) {}
      }
    } catch (_e) {}
  })();

  return localMigrationPromise;
}

async function request(path: string, init?: RequestInit) {
  const res = await fetch(`/api/storage/${path}`, { ...init, cache: 'no-store' });
  if (!res.ok) {
    throw Object.assign(
      new Error(`Speicheranfrage fehlgeschlagen (${res.status}). Bitte erneut versuchen.`),
      { status: res.status }
    );
  }
  return res.json();
}

export async function storageGet<T>(key: string): Promise<T | null> {
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    await initWindowStoragePolyfill();
  }
  try {
    const data = await request(`get?key=${encodeURIComponent(key)}`);
    if (typeof data.value !== 'string') throw new Error('Ungültige Serverantwort.');
    const parsed = JSON.parse(data.value);
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(`tz_cache:${key}`, data.value);
      } catch (_e) {}
    }
    return parsed;
  } catch (error: any) {
    if (error.status === 404) {
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        try {
          const cloudRaw = await firestoreGetRecord(key);
          if (typeof cloudRaw === 'string') {
            if (window.localStorage) {
              try {
                window.localStorage.setItem(`tz_cache:${key}`, cloudRaw);
              } catch (_e) {}
            }
            return JSON.parse(cloudRaw);
          }
        } catch (_e) {}
      }
      return null;
    }
    throw error;
  }
}

export async function storageSet<T>(key: string, value: T): Promise<boolean> {
  const stringValue = JSON.stringify(value);
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(`tz_cache:${key}`, stringValue);
    } catch (_e) {}
  }
  await request('set', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value: stringValue }),
  });
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    firestoreSetRecord(key, stringValue).catch(() => {});
  }
  return true;
}

export async function storageList(prefix: string): Promise<string[]> {
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    await initWindowStoragePolyfill();
  }
  const { keys } = await request(`list?prefix=${encodeURIComponent(prefix)}`);
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) {
    throw new Error('Ungültige Serverantwort.');
  }
  return keys;
}

export async function storageGetMany(prefix: string, suffix = ''): Promise<Record<string, any>> {
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    await initWindowStoragePolyfill();
  }
  const { entries } = await request(
    `entries?prefix=${encodeURIComponent(prefix)}&suffix=${encodeURIComponent(suffix)}`
  );
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error('Ungültige Serverantwort.');
  }
  const result: Record<string, any> = {};
  for (const [key, raw] of Object.entries(entries)) {
    if (typeof raw !== 'string') throw new Error('Ungültiger Datensatz auf dem Server.');
    result[key] = JSON.parse(raw);
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(`tz_cache:${key}`, raw);
      } catch (_e) {}
    }
  }
  return result;
}

export async function storageDelete(key: string): Promise<boolean> {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.removeItem(`tz_cache:${key}`);
      window.localStorage.removeItem(key);
    } catch (_e) {}
  }
  try {
    await request(`delete?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
  } catch (error: any) {
    if (error.status !== 404) throw error;
  }
  return true;
}

export type StorageChangeCallback = (key: string) => void;
export type StreamStatusCallback = (connected: boolean) => void;

/**
 * Subscribe to real-time updates via both Server-Sent Events (SSE) and
 * Cloud Firestore onSnapshot so changes sync immediately across all devices
 * and Cloud Run instances.
 */
export function subscribeToStorageStream(
  onChange: StorageChangeCallback,
  onStatusChange?: StreamStatusCallback
): () => void {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
    return () => {};
  }

  let es: EventSource | null = null;
  let unsubFirestore: (() => void) | null = null;
  let active = true;
  let reconnectTimer: any = null;

  if (typeof document !== 'undefined') {
    try {
      unsubFirestore = subscribeFirestoreChanges(
        (key) => {
          if (active && key.startsWith('session:')) {
            onChange(key);
          }
        },
        (connected) => {
          if (active && connected && onStatusChange) {
            onStatusChange(true);
          }
        }
      );
    } catch (_e) {}
  }

  const connect = () => {
    if (!active) return;
    try {
      es = new EventSource(`/api/storage/stream?_t=${Date.now()}`);

      es.addEventListener('connected', () => {
        if (active && onStatusChange) onStatusChange(true);
      });

      es.addEventListener('ping', () => {
        if (active && onStatusChange) onStatusChange(true);
      });

      es.addEventListener('storage_change', (event) => {
        if (!active) return;
        try {
          const data = JSON.parse(event.data);
          if (data && typeof data.key === 'string') {
            onChange(data.key);
          }
        } catch (_e) {}
      });

      es.onerror = () => {
        if (active && onStatusChange) onStatusChange(false);
        if (es) {
          es.close();
          es = null;
        }
        if (active) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };
    } catch (_e) {
      if (active && onStatusChange) onStatusChange(false);
      if (active) reconnectTimer = setTimeout(connect, 4000);
    }
  };

  connect();

  return () => {
    active = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (unsubFirestore) {
      try {
        unsubFirestore();
      } catch (_e) {}
      unsubFirestore = null;
    }
    if (es) {
      es.close();
      es = null;
    }
    if (onStatusChange) onStatusChange(false);
  };
}
