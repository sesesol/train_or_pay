import fs from 'node:fs';
import path from 'node:path';

// One server process, on a durable volume. Never silently replace unreadable data.
export class Store {
  data: Record<string, string>;
  constructor(public file: string) {
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    if (!this.data || typeof this.data !== 'object' || Array.isArray(this.data)) throw new Error('Invalid storage file');
  }
  get<T = any>(key: string): T | null {
    return Object.hasOwn(this.data, key) ? JSON.parse(this.data[key]) : null;
  }
  commit(updates: Record<string, any>, deletes: string[] = []) {
    const next = { ...this.data };
    for (const [key, value] of Object.entries(updates)) next[key] = JSON.stringify(value);
    for (const key of deletes) delete next[key];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
    this.data = next; // Only acknowledge a write once it has persisted.
  }
}
