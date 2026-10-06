/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Durable key-value store behind /api/storage/*.
 *
 * WHY THIS EXISTS: the app originally kept everything in `.storage_data.json`
 * inside the container. On Cloud Run (where AI Studio deploys) that filesystem
 * is ephemeral: every scale-to-zero, restart or redeploy started with an empty
 * file, so accounts, groups and join codes vanished after some idle time.
 *
 * Backends (no npm dependencies; only Node's fs and global fetch):
 *  - firestore: durable. Chosen automatically on Cloud Run when a Firestore
 *    database exists in the project (auth via the metadata server), or forced
 *    with STORAGE_BACKEND=firestore.
 *  - file: local development fallback. Atomic writes + backup, never silently
 *    replaces a corrupt file. Durable only if DATA_DIR points at a persistent
 *    volume (set STORE_FILE_DURABLE=true to declare that).
 *
 * Deletions leave a tombstone so the client-side recovery (`restore`) can never
 * resurrect data that was intentionally deleted.
 */

import fs from 'fs';
import path from 'path';

export interface StoreHealth {
  backend: 'file' | 'firestore';
  durable: boolean;
  startedAt: string;
  warning?: string;
}

export interface KVStore {
  readonly backend: 'file' | 'firestore';
  readonly durable: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Create only if absent. Returns true if created, false if it already existed. */
  setIfAbsent(key: string, value: string): Promise<boolean>;
  /** Delete and leave a tombstone. Returns true if the key existed. */
  delete(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  /** All entries matching any prefix (and the suffix, if given). */
  entries(prefixes: string[], suffix?: string): Promise<Record<string, string>>;
  /**
   * Insert entries that are missing and not tombstoned. Existing entries are
   * never replaced; known record types are merged (see mergeForRestore).
   */
  restore(entries: Record<string, string>): Promise<{ restored: string[]; skipped: number }>;
}

export const TOMBSTONE_PREFIX = '__tomb__:';
const isInternal = (k: string) => k.startsWith(TOMBSTONE_PREFIX);
const matches = (k: string, prefixes: string[], suffix: string) =>
  !isInternal(k) && prefixes.some((p) => k.startsWith(p)) && (!suffix || k.endsWith(suffix));

// ---------------------------------------------------------------------------
// Merge rules for recovery
// ---------------------------------------------------------------------------
//
// After a store reset, several members' devices each upload their (possibly
// older) cached copy. "First upload wins" would drop newer facts that only a
// later device knows (e.g. a partner's join or Wednesday check-in). For the
// app's known record types we therefore MERGE instead of discarding. Used only
// by restore(); normal writes are unaffected.

const byId = <T>(items: T[], id: (t: T) => string) => {
  const m = new Map<string, T>();
  for (const it of items) if (!m.has(id(it))) m.set(id(it), it);
  return m;
};

function mergeRecord(key: string, a: any, b: any): any | null {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return null;

  if (/^session:[^:]+:meta$/.test(key)) {
    // Union of members; for a member known to both, keep the stored entry.
    const known = new Set((a.members || []).map((m: any) => String(m.user).toLowerCase()));
    const extra = (b.members || []).filter((m: any) => !known.has(String(m.user).toLowerCase()));
    return { ...a, members: [...(a.members || []), ...extra] };
  }
  if (/^user:[^:]+$/.test(key)) {
    // Keep the stored identity (id), union the group codes.
    return { ...a, sessions: Array.from(new Set([...(a.sessions || []), ...(b.sessions || [])])) };
  }
  if (/^session:[^:]+:week:[^:]+:user:[^:]+$/.test(key)) {
    // Union of check-ins (by timestamp). A paused default (goal 0) yields to a real plan.
    const checks = Array.from(byId([...(a.checks || []), ...(b.checks || [])], (c: any) => c.timestamp).values())
      .sort((x: any, y: any) => String(x.timestamp).localeCompare(String(y.timestamp)));
    const goal = (a.goal || 0) === 0 && (b.goal || 0) > 0 ? b.goal : a.goal;
    return { ...a, goal, checks };
  }
  if (/^session:[^:]+:week:[^:]+:exception:/.test(key)) {
    // A decision (approved/rejected) is newer than "pending".
    return a.status === 'pending' && b.status && b.status !== 'pending' ? b : a;
  }
  if (/^session:[^:]+:debts$/.test(key)) {
    const history = Array.from(byId([...(a.history || []), ...(b.history || [])], (d: any) => d.id).values());
    const paid = new Set(history.map((d: any) => d.id));
    const open = new Map<string, any>();
    for (const d of [...(a.open || []), ...(b.open || [])]) {
      if (paid.has(d.id)) continue;
      const cur = open.get(d.id);
      // Same open debt in both copies: the smaller remaining amount is newer (partially paid).
      if (!cur || (d.amountCents ?? Infinity) < (cur.amountCents ?? Infinity)) open.set(d.id, d);
    }
    return { open: Array.from(open.values()), history };
  }
  return null; // unknown type (e.g. settlements): first stored copy wins
}

/** Returns the merged raw value, or null if nothing changes / not mergeable. */
export function mergeForRestore(key: string, existingRaw: string, incomingRaw: string): string | null {
  try {
    const existing = JSON.parse(existingRaw);
    const merged = mergeRecord(key, existing, JSON.parse(incomingRaw));
    if (merged === null) return null;
    const out = JSON.stringify(merged);
    return out === JSON.stringify(existing) ? null : out;
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// File backend
// ---------------------------------------------------------------------------

export class FileStore implements KVStore {
  readonly backend = 'file' as const;
  readonly durable: boolean;
  private data: Record<string, string> = {};
  private readonly file: string;

  constructor(dir: string, durable = false) {
    this.file = path.join(dir, '.storage_data.json');
    this.durable = durable;
    fs.mkdirSync(dir, { recursive: true });
    this.data = this.load();
  }

  /** Read main file; on corruption keep it aside and fall back to the backup. */
  private load(): Record<string, string> {
    const tryRead = (f: string): Record<string, string> | null => {
      if (!fs.existsSync(f)) return null;
      const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return parsed;
    };
    try {
      const main = tryRead(this.file);
      if (main) return main;
    } catch (e) {
      // Never overwrite a corrupt store: move it aside for manual recovery.
      const aside = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, aside);
      } catch (_e) {}
      console.error(`[store] ${this.file} is corrupt, kept as ${aside}. Trying backup.`, e);
    }
    try {
      const bak = tryRead(`${this.file}.bak`);
      if (bak) {
        console.warn('[store] Recovered data from backup file.');
        return bak;
      }
    } catch (e) {
      console.error('[store] Backup file is corrupt as well.', e);
    }
    return {};
  }

  /** Atomic save: write temp file, keep previous version as .bak, rename over. */
  private save() {
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf-8');
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    fs.renameSync(tmp, this.file);
  }

  async get(key: string) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
  }
  async set(key: string, value: string) {
    this.data[key] = value;
    this.save();
  }
  async setIfAbsent(key: string, value: string) {
    if (Object.prototype.hasOwnProperty.call(this.data, key)) return false;
    await this.set(key, value);
    return true;
  }
  async delete(key: string) {
    const existed = Object.prototype.hasOwnProperty.call(this.data, key);
    delete this.data[key];
    this.data[TOMBSTONE_PREFIX + key] = new Date().toISOString();
    this.save();
    return existed;
  }
  async list(prefix: string) {
    return Object.keys(this.data).filter((k) => matches(k, [prefix], ''));
  }
  async entries(prefixes: string[], suffix = '') {
    const out: Record<string, string> = {};
    for (const k of Object.keys(this.data)) if (matches(k, prefixes, suffix)) out[k] = this.data[k];
    return out;
  }
  async restore(entries: Record<string, string>) {
    const restored: string[] = [];
    let skipped = 0;
    for (const [k, v] of Object.entries(entries)) {
      if (typeof v !== 'string' || isInternal(k) || TOMBSTONE_PREFIX + k in this.data) {
        skipped++;
        continue;
      }
      if (k in this.data) {
        const merged = mergeForRestore(k, this.data[k], v);
        if (merged === null) {
          skipped++;
          continue;
        }
        this.data[k] = merged;
      } else {
        this.data[k] = v;
      }
      restored.push(k);
    }
    if (restored.length) this.save();
    return { restored, skipped };
  }

  /** Raw snapshot, used to migrate local data into Firestore. */
  snapshot(): Record<string, string> {
    return { ...this.data };
  }
}

// ---------------------------------------------------------------------------
// Firestore backend (REST, no SDK)
// ---------------------------------------------------------------------------

interface FirestoreConfig {
  projectId: string;
  database: string;
  collection: string;
  /** e.g. "localhost:8080" for the emulator (plain http, no real auth). */
  emulatorHost?: string;
  metadataHost: string;
  /** Static token override (tests). */
  accessToken?: string;
}

const b64url = (s: string) =>
  Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Firestore doc ids may not contain '/', so keys are base64url-encoded. */
export const docIdForKey = (key: string) => `k_${b64url(key)}`;

const lastSegment = (key: string) => {
  const i = key.lastIndexOf(':');
  return i >= 0 ? key.slice(i + 1) : key;
};

export class FirestoreStore implements KVStore {
  readonly backend = 'firestore' as const;
  readonly durable = true;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly cfg: FirestoreConfig) {}

  private get root() {
    const origin = this.cfg.emulatorHost
      ? `http://${this.cfg.emulatorHost}`
      : 'https://firestore.googleapis.com';
    return `${origin}/v1/projects/${this.cfg.projectId}/databases/${this.cfg.database}/documents`;
  }
  private docUrl(key: string) {
    return `${this.root}/${this.cfg.collection}/${docIdForKey(key)}`;
  }

  private async authHeader(): Promise<string> {
    if (this.cfg.emulatorHost) return 'Bearer owner';
    if (this.cfg.accessToken) return `Bearer ${this.cfg.accessToken}`;
    if (this.token && Date.now() < this.token.expiresAt) return `Bearer ${this.token.value}`;
    const res = await fetch(
      `http://${this.cfg.metadataHost}/computeMetadata/v1/instance/service-accounts/default/token`,
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) throw new Error(`metadata token request failed: ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(0, (body.expires_in || 300) - 60) * 1000,
    };
    return `Bearer ${body.access_token}`;
  }

  /** fetch with auth, timeout and one retry on transient errors. */
  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: await this.authHeader(),
          ...(init.headers || {}),
        },
        signal: AbortSignal.timeout(10000),
      });
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      return res;
    }
  }

  private fields(key: string, value: string) {
    return {
      key: { stringValue: key },
      tail: { stringValue: lastSegment(key) },
      value: { stringValue: value },
      updatedAt: { timestampValue: new Date().toISOString() },
    };
  }

  private async fail(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => '');
    throw new Error(`Firestore ${what} failed: ${res.status} ${text.slice(0, 300)}`);
  }

  async get(key: string) {
    const res = await this.call(this.docUrl(key));
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res, 'get');
    const doc = (await res.json()) as any;
    return doc?.fields?.value?.stringValue ?? null;
  }

  async set(key: string, value: string) {
    const res = await this.call(this.docUrl(key), {
      method: 'PATCH',
      body: JSON.stringify({ fields: this.fields(key, value) }),
    });
    if (!res.ok) await this.fail(res, 'set');
  }

  async setIfAbsent(key: string, value: string) {
    const url = `${this.root}/${this.cfg.collection}?documentId=${encodeURIComponent(docIdForKey(key))}`;
    const res = await this.call(url, {
      method: 'POST',
      body: JSON.stringify({ fields: this.fields(key, value) }),
    });
    if (res.status === 409) return false; // ALREADY_EXISTS
    if (!res.ok) await this.fail(res, 'create');
    return true;
  }

  async delete(key: string) {
    const existed = (await this.get(key)) !== null;
    const res = await this.call(this.docUrl(key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) await this.fail(res, 'delete');
    await this.set(TOMBSTONE_PREFIX + key, new Date().toISOString());
    return existed;
  }

  /** Run a structured query and return {key: value} (or just keys with keysOnly). */
  private async query(where: object, keysOnly = false): Promise<Record<string, string>> {
    const structuredQuery: any = { from: [{ collectionId: this.cfg.collection }], where };
    if (keysOnly) structuredQuery.select = { fields: [{ fieldPath: 'key' }] };
    const res = await this.call(`${this.root}:runQuery`, {
      method: 'POST',
      body: JSON.stringify({ structuredQuery }),
    });
    if (!res.ok) await this.fail(res, 'query');
    const rows = (await res.json()) as any[];
    const out: Record<string, string> = {};
    for (const row of Array.isArray(rows) ? rows : []) {
      const f = row?.document?.fields;
      const k = f?.key?.stringValue;
      if (typeof k === 'string') out[k] = keysOnly ? '' : f?.value?.stringValue ?? '';
    }
    return out;
  }

  private prefixFilter(prefix: string) {
    // Single-field range on `key` -> served by Firestore's automatic index.
    return {
      compositeFilter: {
        op: 'AND',
        filters: [
          { fieldFilter: { field: { fieldPath: 'key' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: prefix } } },
          { fieldFilter: { field: { fieldPath: 'key' }, op: 'LESS_THAN', value: { stringValue: prefix + '' } } },
        ],
      },
    };
  }

  async list(prefix: string) {
    return Object.keys(await this.query(this.prefixFilter(prefix), true)).filter((k) =>
      matches(k, [prefix], '')
    );
  }

  async entries(prefixes: string[], suffix = '') {
    let merged: Record<string, string> = {};
    if (/^:[^:]+$/.test(suffix)) {
      // e.g. ':meta' -> equality on `tail` (auto-indexed) reads only the meta
      // docs instead of every document of every session.
      merged = await this.query({
        fieldFilter: { field: { fieldPath: 'tail' }, op: 'EQUAL', value: { stringValue: suffix.slice(1) } },
      });
    } else {
      const parts = await Promise.all(prefixes.map((p) => this.query(this.prefixFilter(p))));
      for (const p of parts) Object.assign(merged, p);
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) if (matches(k, prefixes, suffix)) out[k] = v;
    return out;
  }

  async restore(entries: Record<string, string>) {
    const tombs = new Set(Object.keys(await this.query(this.prefixFilter(TOMBSTONE_PREFIX), true)));
    const candidates = Object.entries(entries).filter(
      ([k, v]) => typeof v === 'string' && !isInternal(k) && !tombs.has(TOMBSTONE_PREFIX + k)
    );
    const restored: string[] = [];
    // Create-if-absent per key with bounded concurrency; existing docs are only
    // merged (never replaced) for the record types mergeForRestore knows.
    let i = 0;
    const worker = async () => {
      while (i < candidates.length) {
        const [k, v] = candidates[i++];
        try {
          if (await this.setIfAbsent(k, v)) {
            restored.push(k);
          } else {
            const current = await this.get(k);
            const merged = current === null ? null : mergeForRestore(k, current, v);
            if (merged !== null) {
              await this.set(k, merged);
              restored.push(k);
            }
          }
        } catch (e) {
          console.warn('[store] restore failed for', k, e);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, worker));
    return { restored, skipped: Object.keys(entries).length - restored.length };
  }

  /** Cheap reachability/permission check used to pick the backend. */
  async probe(): Promise<void> {
    await this.query({ fieldFilter: { field: { fieldPath: 'tail' }, op: 'EQUAL', value: { stringValue: '__probe__' } } }, true);
  }
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

async function resolveProjectId(metadataHost: string): Promise<string | null> {
  const fromEnv =
    process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (fromEnv) return fromEnv;
  try {
    const res = await fetch(`http://${metadataHost}/computeMetadata/v1/project/project-id`, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok ? (await res.text()).trim() : null;
  } catch (_e) {
    return null;
  }
}

export interface CreatedStore {
  store: KVStore;
  health: StoreHealth;
}

export async function createStore(env: Record<string, string | undefined> = process.env): Promise<CreatedStore> {
  const startedAt = new Date().toISOString();
  const mode = (env.STORAGE_BACKEND || 'auto').toLowerCase();
  const fileStore = new FileStore(env.DATA_DIR || process.cwd(), env.STORE_FILE_DURABLE === 'true');

  const onCloud = !!(env.K_SERVICE || env.FIRESTORE_EMULATOR_HOST || env.FIRESTORE_PROJECT_ID);
  const wantFirestore = mode === 'firestore' || (mode === 'auto' && onCloud);

  let warning: string | undefined;
  if (wantFirestore) {
    const metadataHost = env.GCE_METADATA_HOST || 'metadata.google.internal';
    const projectId = await resolveProjectId(metadataHost);
    if (projectId) {
      const fsStore = new FirestoreStore({
        projectId,
        database: env.FIRESTORE_DATABASE || '(default)',
        collection: env.FIRESTORE_COLLECTION || 'kv',
        emulatorHost: env.FIRESTORE_EMULATOR_HOST,
        metadataHost,
        accessToken: env.FIRESTORE_ACCESS_TOKEN,
      });
      try {
        await fsStore.probe();
        // One-time migration: copy anything the local file has into Firestore
        // (create-if-absent, so existing cloud data is never overwritten).
        const local = fileStore.snapshot();
        if (Object.keys(local).length) {
          const { restored } = await fsStore.restore(local);
          if (restored.length) console.log(`[store] Migrated ${restored.length} keys into Firestore.`);
        }
        console.log(`[store] Using Firestore (project ${projectId}) — data is durable.`);
        return { store: fsStore, health: { backend: 'firestore', durable: true, startedAt } };
      } catch (e: any) {
        warning = `Firestore nicht nutzbar: ${e?.message || e}`;
      }
    } else {
      warning = 'Firestore nicht nutzbar: keine Projekt-ID gefunden.';
    }
  }

  if (!fileStore.durable) {
    const msg =
      'Daten liegen nur im Container-Dateisystem und gehen bei Neustart/Inaktivität verloren.';
    warning = warning ? `${warning} ${msg}` : msg;
    console.warn(`[store] WARNING: ${warning}`);
  }
  return {
    store: fileStore,
    health: { backend: 'file', durable: fileStore.durable, startedAt, warning },
  };
}
