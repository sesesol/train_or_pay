import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { createApi } from './server/api.ts';
import { Store } from './server/store.ts';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const dataFile = process.env.STORAGE_DATA_FILE || path.join(process.cwd(), '.storage_data.json');
const store = new Store(dataFile);
app.use('/api', createApi(store, {
  secureCookies: process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production',
  migrationSecret: process.env.ACCOUNT_MIGRATION_SECRET,
}));

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }
  app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
}
startServer();
