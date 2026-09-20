import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { FileStore } from '../server/store.ts';
import { StorageStream, storageChangeEvent } from '../server/stream.ts';
import { storageGet, storageGetMany, storageList, storageDelete, storageSet, subscribeToStorageStream } from '../src/lib/storage.ts';
import { readLoginSession } from '../src/lib/session.ts';

function globalValue(t: any, name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete (globalThis as any)[name]; });
}
function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'data.json') };
}
test('data persists after a new store instance and deletion stays deleted', t => {
  const { file } = fixture(t); const store = new FileStore(file);
  store.set('user:someone', JSON.stringify({ sessions: ['ABC234'] }));
  assert.equal(new FileStore(file).get('user:someone'), store.get('user:someone'));
  assert.equal(store.delete('user:someone'), true);
  assert.equal(new FileStore(file).get('user:someone'), undefined);
  assert.equal(store.delete('missing'), false);
});
test('malformed storage stops startup rather than silently resetting all users', t => {
  const { file } = fixture(t);
  for (const value of ['{', 'null', '[]', '{"a":42}']) {
    fs.writeFileSync(file, value); assert.throws(() => new FileStore(file));
    assert.equal(fs.readFileSync(file, 'utf8'), value);
  }
});
test('failed writes and deletes preserve both the previous file and memory', t => {
  const { file } = fixture(t); const store = new FileStore(file);
  store.set('important', 'old');
  fs.mkdirSync(`${file}.tmp`);
  assert.throws(() => store.set('important', 'new'));
  assert.throws(() => store.delete('important'));
  assert.equal(store.get('important'), 'old');
  assert.equal(new FileStore(file).get('important'), 'old');
});
test('special object keys round-trip as data instead of modifying prototypes', t => {
  const { file } = fixture(t); const store = new FileStore(file);
  store.set('__proto__', 'value');
  assert.equal(store.get('__proto__'), 'value');
  assert.equal(store.get('constructor'), undefined);
  assert.equal(store.entries()['__proto__'], 'value');
});
test('SSE does not broadcast profile keys or values', () => {
  assert.equal(storageChangeEvent('user:alice'), null);
  assert.equal(storageChangeEvent('recent:users'), null);
  const event = storageChangeEvent('session:ABC234:meta')!;
  const data = JSON.parse(event.split('data: ')[1]);
  assert.deepEqual(Object.keys(data).sort(), ['key', 'ts']);
});
test('slow SSE clients are closed and removed', () => {
  class Client extends EventEmitter {
    destroyed = false; writableEnded = false; writes: string[] = []; accept = true;
    write(value: string) { this.writes.push(value); return this.accept; }
    end() { this.writableEnded = true; }
  }
  const client = new Client(); const stream = new StorageStream();
  stream.add(client as any); client.accept = false;
  stream.notify('session:ABC234:meta');
  assert.ok(client.writableEnded);
  const count = client.writes.length;
  stream.notify('session:ABC234:meta'); assert.equal(client.writes.length, count);
});
function response(t: any, status: number, data: any) {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
}
test('only a real 404 is interpreted as a missing user', async t => {
  response(t, 404, { error: 'not found' }); assert.equal(await storageGet('user:a'), null);
});
test('server failure is not interpreted as a new account, empty groups, or successful delete', async t => {
  response(t, 500, { error: 'disk failed' });
  await assert.rejects(storageGet('user:a'));
  await assert.rejects(storageList('session:'));
  await assert.rejects(storageGetMany('session:'));
  await assert.rejects(storageDelete('session:ABC234:meta'));
  await assert.rejects(storageSet('user:a', {}));
});
test('network failure does not trigger local-cache fallback', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  await assert.rejects(storageGet('user:a'), /offline/);
  await assert.rejects(storageGetMany('session:'), /offline/);
});
test('malformed batch records are not silently discarded', async t => {
  response(t, 200, { entries: { 'session:ABC234:meta': '{' } });
  await assert.rejects(storageGetMany('session:'));
});
test('missing, invalid and expired login timestamps cannot persist forever', t => {
  let stored: any;
  const localStorage = { getItem: () => JSON.stringify(stored), removeItem: () => { stored = null; } };
  globalValue(t, 'window', { localStorage } as any);
  for (const expiresAt of [undefined, 'invalid-date', '2000-01-01T00:00:00Z']) {
    stored = { userId: 'a', usernameLower: 'alice', expiresAt };
    assert.equal(readLoginSession(), null);
  }
  stored = { userId: 'a', usernameLower: 'alice', expiresAt: new Date(Date.now() + 10000).toISOString() };
  assert.equal(readLoginSession()?.userId, 'a');
});
test('stream cleanup stops notifications and clears the connection', t => {
  let source: FakeSource;
  class FakeSource {
    listeners = new Map<string, Function>(); closed = false; onerror: Function;
    constructor(_url: string) { source = this; }
    addEventListener(name: string, fn: Function) { this.listeners.set(name, fn); }
    close() { this.closed = true; }
  }
  globalValue(t, 'window', {} as any);
  globalValue(t, 'EventSource', FakeSource as any);
  const keys: string[] = [], statuses: boolean[] = [];
  const unsubscribe = subscribeToStorageStream(key => keys.push(key), status => statuses.push(status));
  source!.listeners.get('connected')!();
  source!.listeners.get('storage_change')!({ data: JSON.stringify({ key: 'session:ABC234:meta' }) });
  assert.deepEqual(keys, ['session:ABC234:meta']);
  unsubscribe(); assert.ok(source!.closed); assert.deepEqual(statuses, [true, false]);
  source!.listeners.get('storage_change')!({ data: JSON.stringify({ key: 'other' }) });
  assert.equal(keys.length, 1);
});
