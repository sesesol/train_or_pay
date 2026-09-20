import express from 'express';
import path from 'path';
import 'dotenv/config';
import { FileStore } from './server/store.ts';
import { StorageStream } from './server/stream.ts';
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '10mb' }));

const store = new FileStore(process.env.STORAGE_DATA_FILE || path.join(process.cwd(), '.storage_data.json'));
const stream = new StorageStream();
if (process.env.K_SERVICE && !process.env.STORAGE_DATA_FILE) {
  console.warn('Cloud Run: local storage is ephemeral. Configure a durable data backend before relying on this deployment.');
}

// Ensure NO intermediate caching or browser heuristic caching for any storage API
app.use('/api/storage', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Real-time Server-Sent Events (SSE) stream for instant synchronization
app.get('/api/storage/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  stream.add(res);
});

// REST API for window.storage shared persistence
app.get('/api/storage/get', (req, res) => {
  const key = req.query.key as string;
  if (typeof key !== 'string' || !key || key.length > 512) {
    return res.status(400).json({ error: 'Key is required' });
  }
  if (store.get(key) !== undefined) {
    return res.json({ key, value: store.get(key) });
  } else {
    return res.status(404).json({ error: `Key not found: ${key}` });
  }
});

app.post('/api/storage/set', (req, res) => {
  const { key, value } = req.body;
  if (typeof key !== 'string' || !key || key.length > 512 || typeof value === 'undefined') {
    return res.status(400).json({ error: 'Key and value are required' });
  }
  const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
  store.set(key, stringValue);
  stream.notify(key);
  return res.json({ success: true, key });
});

// Batch read: return every key/value pair under a prefix in ONE request.
// Avoids dozens of sequential round trips when loading a whole session.
app.get('/api/storage/entries', (req, res) => {
  const prefix = (req.query.prefix as string) || '';
  const suffix = (req.query.suffix as string) || '';
  const entries = store.entries(prefix, suffix);
  return res.json({ entries });
});

app.get('/api/storage/list', (req, res) => {
  const prefix = (req.query.prefix as string) || '';
  const matchedKeys = Object.keys(store.entries(prefix));
  return res.json({ keys: matchedKeys });
});

app.delete('/api/storage/delete', (req, res) => {
  const key = req.query.key as string;
  if (typeof key !== 'string' || !key || key.length > 512) {
    return res.status(400).json({ error: 'Key is required' });
  }
  if (store.get(key) !== undefined) {
    store.delete(key);
    stream.notify(key);
    return res.json({ success: true, deleted: key });
  } else {
    return res.status(404).json({ error: `Key not found: ${key}` });
  }
});

// The previous public reset endpoint could erase every real user's records.
app.post('/api/storage/reset-demo', (_req, res) => res.status(403).json({ error: 'Global reset is disabled.' }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Storage request failed:', error.message);
  res.status(error.status || 500).json({ error: 'Daten konnten nicht geladen oder gespeichert werden. Bitte erneut versuchen.' });
});

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
