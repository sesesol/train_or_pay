/** The server is authoritative; cached data must never turn failed reads into new accounts. */
export function initWindowStoragePolyfill() {}

async function request(path: string, init?: RequestInit) {
  const res = await fetch(`/api/storage/${path}`, { ...init, cache: 'no-store' });
  if (!res.ok) throw Object.assign(new Error(`Speicheranfrage fehlgeschlagen (${res.status}). Bitte erneut versuchen.`), { status: res.status });
  return res.json();
}
export async function storageGet<T>(key: string): Promise<T | null> {
  try {
    const data = await request(`get?key=${encodeURIComponent(key)}`);
    if (typeof data.value !== 'string') throw new Error('Ungültige Serverantwort.');
    return JSON.parse(data.value);
  } catch (error: any) {
    if (error.status === 404) return null;
    throw error;
  }
}
export async function storageSet<T>(key: string, value: T): Promise<boolean> {
  await request('set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value: JSON.stringify(value) }) });
  return true;
}
export async function storageList(prefix: string): Promise<string[]> {
  const { keys } = await request(`list?prefix=${encodeURIComponent(prefix)}`);
  if (!Array.isArray(keys) || keys.some(k => typeof k !== 'string')) throw new Error('Ungültige Serverantwort.');
  return keys;
}
export async function storageGetMany(prefix: string, suffix = ''): Promise<Record<string, any>> {
  const { entries } = await request(`entries?prefix=${encodeURIComponent(prefix)}&suffix=${encodeURIComponent(suffix)}`);
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Ungültige Serverantwort.');
  return Object.fromEntries(Object.entries(entries).map(([key, raw]) => {
    if (typeof raw !== 'string') throw new Error('Ungültiger Datensatz auf dem Server.');
    return [key, JSON.parse(raw)];
  }));
}
export async function storageDelete(key: string): Promise<boolean> {
  try { await request(`delete?key=${encodeURIComponent(key)}`, { method: 'DELETE' }); }
  catch (error: any) { if (error.status !== 404) throw error; }
  return true;
}

export type StorageChangeCallback = (key: string) => void;
export type StreamStatusCallback = (connected: boolean) => void;

/**
 * Subscribe to real-time Server-Sent Events (SSE) so that any check-in or change
 * made by any member is immediately pushed to this client with zero delay.
 */
export function subscribeToStorageStream(
  onChange: StorageChangeCallback,
  onStatusChange?: StreamStatusCallback
): () => void {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
    return () => {};
  }

  let es: EventSource | null = null;
  let active = true;
  let reconnectTimer: any = null;

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
    if (es) {
      es.close();
      es = null;
    }
    if (onStatusChange) onStatusChange(false);
  };
}
