import fs from 'node:fs';
import path from 'node:path';

/** Single-process file store. A durable volume is still required in production. */
export class FileStore {
  private values: Record<string, string>;
  constructor(readonly file: string) {
    this.values = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    if (!this.values || typeof this.values !== 'object' || Array.isArray(this.values) || Object.values(this.values).some(v => typeof v !== 'string')) {
      throw new Error('Invalid storage file; restore a backup instead of starting with empty data.');
    }
  }
  get(key: string) { return Object.hasOwn(this.values, key) ? this.values[key] : undefined; }
  entries(prefix = '', suffix = '') {
    return Object.fromEntries(Object.entries(this.values).filter(([k]) => k.startsWith(prefix) && k.endsWith(suffix)));
  }
  private persist(next: Record<string, string>) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
    this.values = next;
  }
  set(key: string, value: string) { this.persist({ ...this.values, [key]: value }); }
  delete(key: string) {
    if (!Object.hasOwn(this.values, key)) return false;
    const next = { ...this.values }; delete next[key]; this.persist(next); return true;
  }
}
