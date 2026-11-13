import express from 'express';
import path from 'path';
import 'dotenv/config';
import { FileStore } from './server/store.ts';
import { StorageStream } from './server/stream.ts';
import {
  firestoreGetRecord,
  firestoreSetRecord,
  firestoreDeleteRecord,
  firestoreQueryEntries,
  subscribeFirestoreChanges,
} from './src/lib/firebase.ts';
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '10mb' }));

const store = new FileStore(
  process.env.STORAGE_DATA_FILE || path.join(process.cwd(), '.storage_data.json')
);
const stream = new StorageStream();

// Sync between local FileStore cache and Cloud Firestore
async function initCloudSync() {
  try {
    const cloudEntries = await firestoreQueryEntries('', '');
    for (const [k, v] of Object.entries(cloudEntries)) {
      if (store.get(k) !== v) {
        try {
          store.set(k, v);
        } catch (_e) {}
      }
    }
    const localEntries = store.entries('', '');
    for (const [k, v] of Object.entries(localEntries)) {
      if (!(k in cloudEntries)) {
        firestoreSetRecord(k, v).catch(() => {});
      }
    }
  } catch (err: any) {
    console.warn('Initial Firestore sync warning:', err?.message || err);
  }

  subscribeFirestoreChanges((key, value, deleted) => {
    try {
      if (deleted) {
        if (store.get(key) !== undefined) {
          store.delete(key);
          stream.notify(key);
        }
      } else if (typeof value === 'string' && store.get(key) !== value) {
        store.set(key, value);
        stream.notify(key);
      }
    } catch (_e) {}
  });
}

initCloudSync();

// Ensure NO intermediate caching or browser heuristic caching for any storage API
app.use('/api/storage', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Real-time Server-Sent Events (SSE) stream for instant synchronization
app.get('/api/storage/stream', (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  stream.add(res);
});

// REST API for shared persistence backed by Cloud Firestore + FileStore
app.get('/api/storage/get', async (req, res, next) => {
  try {
    const key = req.query.key as string;
    if (typeof key !== 'string' || !key || key.length > 512) {
      return res.status(400).json({ error: 'Key is required' });
    }

    let value: string | undefined;
    try {
      value = await firestoreGetRecord(key);
      if (value !== undefined && store.get(key) !== value) {
        store.set(key, value);
      }
    } catch (_cloudErr) {
      value = store.get(key);
    }

    if (value === undefined) {
      const localVal = store.get(key);
      if (localVal !== undefined) {
        value = localVal;
        firestoreSetRecord(key, localVal).catch(() => {});
      }
    }

    if (value !== undefined) {
      return res.json({ key, value });
    } else {
      return res.status(404).json({ error: `Key not found: ${key}` });
    }
  } catch (err) {
    next(err);
  }
});

app.post('/api/storage/set', async (req, res, next) => {
  try {
    const { key, value } = req.body;
    if (typeof key !== 'string' || !key || key.length > 512 || typeof value === 'undefined') {
      return res.status(400).json({ error: 'Key and value are required' });
    }
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    store.set(key, stringValue);
    await firestoreSetRecord(key, stringValue);
    stream.notify(key);
    return res.json({ success: true, key });
  } catch (err) {
    next(err);
  }
});

// Batch read: return every key/value pair under a prefix in ONE request.
app.get('/api/storage/entries', async (req, res, next) => {
  try {
    const prefix = (req.query.prefix as string) || '';
    const suffix = (req.query.suffix as string) || '';
    let cloudEntries: Record<string, string> = {};
    try {
      cloudEntries = await firestoreQueryEntries(prefix, suffix);
      for (const [k, v] of Object.entries(cloudEntries)) {
        if (store.get(k) !== v) {
          store.set(k, v);
        }
      }
    } catch (_cloudErr) {
      // Fallback to local store if cloud read fails
    }

    const localEntries = store.entries(prefix, suffix);
    for (const [k, v] of Object.entries(localEntries)) {
      if (!(k in cloudEntries)) {
        cloudEntries[k] = v;
        firestoreSetRecord(k, v).catch(() => {});
      }
    }

    return res.json({ entries: cloudEntries });
  } catch (err) {
    next(err);
  }
});

app.get('/api/storage/list', async (req, res, next) => {
  try {
    const prefix = (req.query.prefix as string) || '';
    let cloudEntries: Record<string, string> = {};
    try {
      cloudEntries = await firestoreQueryEntries(prefix, '');
    } catch (_cloudErr) {}
    const localEntries = store.entries(prefix, '');
    const matchedKeys = Array.from(
      new Set([...Object.keys(cloudEntries), ...Object.keys(localEntries)])
    );
    return res.json({ keys: matchedKeys });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/storage/delete', async (req, res, next) => {
  try {
    const key = req.query.key as string;
    if (typeof key !== 'string' || !key || key.length > 512) {
      return res.status(400).json({ error: 'Key is required' });
    }
    const existedLocal = store.get(key) !== undefined;
    if (existedLocal) {
      store.delete(key);
    }
    let existedCloud = false;
    try {
      existedCloud = await firestoreDeleteRecord(key);
    } catch (_cloudErr) {}

    if (existedLocal || existedCloud) {
      stream.notify(key);
      return res.json({ success: true, deleted: key });
    } else {
      return res.status(404).json({ error: `Key not found: ${key}` });
    }
  } catch (err) {
    next(err);
  }
});

// The previous public reset endpoint could erase every real user's records.
app.post('/api/storage/reset-demo', (_req, res) =>
  res.status(403).json({ error: 'Global reset is disabled.' })
);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));
app.use(
  (error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Storage request failed:', error.message);
    res
      .status(error.status || 500)
      .json({ error: 'Daten konnten nicht geladen oder gespeichert werden. Bitte erneut versuchen.' });
  }
);

async function startServer() {
  // Vite middleware for development
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
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
