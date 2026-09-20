/** Shared data always comes from the authenticated server, never a device cache. */
import { apiRequest } from './api.ts';

// Retained for callers from older versions; a host-provided window.storage is
// deliberately not used because it may point to a different dataset per device.
export function initWindowStoragePolyfill() {}

export async function storageGet<T>(key: string): Promise<T | null> {
  try {
    const result = await apiRequest<{ value: string }>(`/storage/get?key=${encodeURIComponent(key)}`);
    return JSON.parse(result.value);
  } catch (error: any) {
    if (error.status === 404) return null;
    throw error;
  }
}
export async function storageSet<T>(key: string, value: T): Promise<boolean> {
  await apiRequest('/storage/set', { key, value: JSON.stringify(value) });
  return true;
}
export async function storageList(prefix: string): Promise<string[]> {
  return (await apiRequest<{ keys: string[] }>(`/storage/list?prefix=${encodeURIComponent(prefix)}`)).keys;
}
export async function storageGetMany(prefix: string, suffix = ''): Promise<Record<string, any>> {
  const { entries } = await apiRequest<{ entries: Record<string, string> }>(`/storage/entries?prefix=${encodeURIComponent(prefix)}&suffix=${encodeURIComponent(suffix)}`);
  return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, JSON.parse(value)]));
}
export async function storageDelete(key: string): Promise<boolean> {
  const response = await fetch(`/api/storage/delete?key=${encodeURIComponent(key)}`, { method: 'DELETE', credentials: 'same-origin' });
  if (!response.ok) throw new Error((await response.json()).error || 'Löschen fehlgeschlagen.');
  return true;
}
