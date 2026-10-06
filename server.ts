import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createStore, KVStore, StoreHealth } from './server/store.ts';

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

let store: KVStore;
let health: StoreHealth;

// Every storage response tells the client which store instance answered and
// whether it is durable, so the client can re-upload its local copy right
// after a non-durable store was reset (see src/lib/storage.ts).
app.use('/api/storage', (_req, res, next) => {
  res.setHeader('X-Store-Epoch', health.startedAt);
  res.setHeader('X-Store-Durable', health.durable ? '1' : '0');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const asList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(String);

/** Wrap async handlers: backend failures become 503 instead of crashing. */
const route =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e) => {
      console.error('[api] storage error:', e);
      if (!res.headersSent) res.status(503).json({ error: 'Speicher vorübergehend nicht erreichbar.' });
    });

app.get('/api/storage/health', (_req, res) => res.json(health));

app.get('/api/storage/get', route(async (req, res) => {
  const key = req.query.key as string;
  if (!key) return res.status(400).json({ error: 'Key is required' });
  const value = await store.get(key);
  if (value === null) return res.status(404).json({ error: `Key not found: ${key}` });
  return res.json({ key, value });
}));

app.post('/api/storage/set', route(async (req, res) => {
  const { key, value } = req.body || {};
  if (!key || typeof value === 'undefined') return res.status(400).json({ error: 'Key and value are required' });
  await store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  return res.json({ success: true, key });
}));

// Create-only write. Used where two clients could race to create the same
// record (e.g. a week's settlement): exactly one of them wins.
app.post('/api/storage/set-if-absent', route(async (req, res) => {
  const { key, value } = req.body || {};
  if (!key || typeof value === 'undefined') return res.status(400).json({ error: 'Key and value are required' });
  const created = await store.setIfAbsent(key, typeof value === 'string' ? value : JSON.stringify(value));
  return res.json({ created, key });
}));

app.get('/api/storage/list', route(async (req, res) => {
  const prefix = (req.query.prefix as string) || '';
  return res.json({ keys: await store.list(prefix) });
}));

// Batch read: every key/value under one or more prefixes in ONE request.
app.get('/api/storage/entries', route(async (req, res) => {
  const prefixes = asList(req.query.prefix);
  const suffix = (req.query.suffix as string) || '';
  return res.json({ entries: await store.entries(prefixes.length ? prefixes : [''], suffix) });
}));

app.delete('/api/storage/delete', route(async (req, res) => {
  const key = req.query.key as string;
  if (!key) return res.status(400).json({ error: 'Key is required' });
  const existed = await store.delete(key);
  if (!existed) return res.status(404).json({ error: `Key not found: ${key}` });
  return res.json({ success: true, deleted: key });
}));

// Self-healing: clients upload the data they have cached locally; only keys
// that are missing on the server (and were not deliberately deleted) are
// inserted. Existing server data is never overwritten.
app.post('/api/storage/restore', route(async (req, res) => {
  const entries = req.body?.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    return res.status(400).json({ error: 'entries object is required' });
  }
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries)) if (typeof v === 'string') clean[k] = v;
  const { restored, skipped } = await store.restore(clean);
  if (restored.length) console.log(`[store] Restored ${restored.length} keys from a client cache.`);
  return res.json({ restored: restored.length, skipped });
}));

// NOTE: the former POST /api/storage/reset-demo endpoint wiped the whole store
// without any check and was reachable by anyone. It has been removed.

async function startServer() {
  ({ store, health } = await createStore());

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT} (storage: ${health.backend}, durable: ${health.durable})`);
  });
}

startServer();
