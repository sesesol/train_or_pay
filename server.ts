import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

// In-memory + persistent file storage for shared key-value store
const DATA_FILE = path.join(process.cwd(), '.storage_data.json');
let memoryStore: Record<string, string> = {};

// Load persisted data if available
try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    memoryStore = JSON.parse(raw);
  }
} catch (e) {
  console.warn('Could not read existing storage file, starting fresh:', e);
}

function saveStore() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(memoryStore, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to persist store:', e);
  }
}

// REST API for window.storage shared persistence
app.get('/api/storage/get', (req, res) => {
  const key = req.query.key as string;
  if (!key) {
    return res.status(400).json({ error: 'Key is required' });
  }
  if (Object.prototype.hasOwnProperty.call(memoryStore, key)) {
    return res.json({ key, value: memoryStore[key] });
  } else {
    return res.status(404).json({ error: `Key not found: ${key}` });
  }
});

app.post('/api/storage/set', (req, res) => {
  const { key, value } = req.body;
  if (!key || typeof value === 'undefined') {
    return res.status(400).json({ error: 'Key and value are required' });
  }
  memoryStore[key] = typeof value === 'string' ? value : JSON.stringify(value);
  saveStore();
  return res.json({ success: true, key });
});

app.get('/api/storage/list', (req, res) => {
  const prefix = (req.query.prefix as string) || '';
  const matchedKeys = Object.keys(memoryStore).filter((k) => k.startsWith(prefix));
  return res.json({ keys: matchedKeys });
});

app.delete('/api/storage/delete', (req, res) => {
  const key = req.query.key as string;
  if (!key) {
    return res.status(400).json({ error: 'Key is required' });
  }
  if (Object.prototype.hasOwnProperty.call(memoryStore, key)) {
    delete memoryStore[key];
    saveStore();
    return res.json({ success: true, deleted: key });
  } else {
    return res.status(404).json({ error: `Key not found: ${key}` });
  }
});

app.post('/api/storage/reset-demo', (req, res) => {
  // Clear or seed demo data
  memoryStore = {};
  saveStore();
  return res.json({ success: true });
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
