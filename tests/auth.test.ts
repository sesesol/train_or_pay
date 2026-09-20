import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApi } from '../server/api.ts';
import { Store } from '../server/store.ts';
import { digest, migrationToken } from '../server/auth.ts';

const password = 'a secure test password';
const secret = 'test-only-migration-secret-at-least-32-characters';
async function fixture(t: any, initial: Record<string, any> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'train-auth-'));
  const file = path.join(dir, 'data.json');
  const store = new Store(file);
  store.commit(initial);
  const app = express();
  app.use('/api', createApi(store, { secureCookies: false, migrationSecret: secret }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); });
  const address = server.address() as { port: number };
  function device() {
    let cookie = '';
    return {
      token: () => cookie,
      async request(route: string, body?: any, method = body === undefined ? 'GET' : 'POST') {
        const res = await fetch(`http://127.0.0.1:${address.port}/api${route}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
        const setCookie = res.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        return { status: res.status, data: await res.json(), setCookie };
      },
    };
  }
  return { store, file, device };
}
const legacy = (pinHash: string | null = null) => ({ id: 'original-id', displayName: 'Sepehr', pinHash, createdAt: '2025-01-01', sessions: [] });
const group = (active = true, userId?: string) => ({ code: 'ABC234', name: 'Friends', createdAt: '2025-01-01', adminUser: 'sepehr', members: [{ user: 'sepehr', userId, displayName: 'Sepehr', active, penaltyCents: 500, joinedAt: '2025-01-01' }], settings: { allowMultiplePerDay: false } });

test('new account, second device, server-derived groups, restart, expiry and logout', async t => {
  const { device, store, file } = await fixture(t);
  const first = device(), second = device();
  const registered = await first.request('/auth/register', { username: '  Sepehr  ', password });
  assert.equal(registered.status, 200);
  assert.match(registered.setCookie!, /HttpOnly/);
  assert.match(registered.setCookie!, /SameSite=Lax/);
  assert.match(registered.setCookie!, /Max-Age=5184000/);
  const id = registered.data.profile.id;
  assert.equal(registered.data.profile.passwordHash, undefined);
  assert.notEqual(store.get('user:sepehr').passwordHash, password);
  assert.equal((await second.request('/auth/login', { username: 'sepehr', password: 'incorrect' })).status, 401);
  const created = await first.request('/groups/create', { name: 'Friends', penaltyCents: 500 });
  assert.equal(created.status, 200);
  const code = created.data.session.code;
  // Deliberately stale/missing profile index must not lose membership.
  store.commit({ 'user:sepehr': { ...store.get('user:sepehr'), sessions: [] } });
  const loggedIn = await second.request('/auth/login', { username: 'SEPEHR', password });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.data.profile.id, id);
  assert.deepEqual(loggedIn.data.profile.sessions, [code]);
  assert.equal((await second.request('/groups')).data.groups[0].code, code);
  assert.equal((await second.request('/auth/me')).data.profile.id, id);
  assert.equal((await first.request('/auth/register', { username: 'sepehr', password })).status, 409);
  assert.equal((await first.request('/storage/set', { key: 'user:sepehr', value: { id: 'evil', passwordHash: 'bad', sessions: [] } })).status, 200);
  assert.equal(store.get('user:sepehr').id, id);
  assert.deepEqual(store.get('user:sepehr').sessions, [code]);
  const restarted = new Store(file);
  assert.equal(restarted.get(`session:${code}:meta`).members[0].userId, id);
  assert.ok(restarted.get(`auth:${digest(second.token().split('=')[1])}`));
  assert.equal((await first.request('/auth/logout', {})).status, 200);
  assert.equal((await first.request('/auth/me')).status, 401);
  assert.equal((await second.request('/auth/me')).status, 200);
  const key = `auth:${digest(second.token().split('=')[1])}`;
  store.commit({ [key]: { ...store.get(key), expiresAt: 1 } });
  assert.equal((await second.request('/auth/me')).status, 401);
});

test('PIN migration preserves id, old group and history, and only works once', async t => {
  const { device, store } = await fixture(t, { 'user:sepehr': legacy('1234'), 'session:ABC234:meta': group(), 'session:ABC234:week:2025-W01:user:sepehr': { goal: 3, checks: [] } });
  const first = device();
  assert.equal((await first.request('/auth/login', { username: 'sepehr', password: '1234' })).status, 401);
  assert.equal((await first.request('/auth/migrate', { username: 'sepehr', password, proof: '9999' })).status, 401);
  const migrated = await first.request('/auth/migrate', { username: 'sepehr', password, proof: '1234' });
  assert.equal(migrated.status, 200);
  assert.equal(migrated.data.profile.id, 'original-id');
  assert.deepEqual(migrated.data.profile.sessions, ['ABC234']);
  assert.equal(store.get('user:sepehr').pinHash, null);
  assert.equal(store.get('session:ABC234:week:2025-W01:user:sepehr').goal, 3);
  assert.equal((await device().request('/auth/migrate', { username: 'sepehr', password, proof: '1234' })).status, 401);
  const second = device();
  assert.equal((await second.request('/auth/login', { username: 'Sepehr', password })).status, 200);
  assert.equal((await second.request('/groups')).data.groups[0].code, 'ABC234');
});

test('passwordless legacy accounts require operator proof, not username or public id', async t => {
  const { device } = await fixture(t, { 'user:sepehr': legacy(), 'session:ABC234:meta': group() });
  const d = device();
  for (const proof of ['', 'original-id', migrationToken('someone-else', secret, Date.now() + 60000), migrationToken('sepehr', secret, 1)]) {
    assert.equal((await d.request('/auth/migrate', { username: 'sepehr', password, proof })).status, 401);
  }
  const proof = migrationToken('sepehr', secret, Date.now() + 60000);
  assert.equal((await d.request('/auth/migrate', { username: 'sepehr', password, proof })).status, 200);
  assert.equal((await d.request('/groups')).data.groups.length, 1);
  assert.equal((await device().request('/auth/migrate', { username: 'sepehr', password, proof })).status, 401);
});

test('group joins are atomic and survive stale profile writes; removed memberships are excluded', async t => {
  const { device, store } = await fixture(t);
  const owner = device(), friend = device();
  await owner.request('/auth/register', { username: 'owner', password });
  await friend.request('/auth/register', { username: 'friend', password });
  const a = (await owner.request('/groups/create', { name: 'Group A', penaltyCents: 500 })).data.session;
  const b = (await owner.request('/groups/create', { name: 'Group B', penaltyCents: 500 })).data.session;
  assert.equal((await friend.request(`/storage/get?key=session:${a.code}:meta`)).status, 403);
  const results = await Promise.all([a, b].map(g => friend.request('/groups/join', { code: g.code.toLowerCase(), penaltyCents: 1000 })));
  assert.ok(results.every(r => r.status === 200));
  await friend.request('/storage/set', { key: 'user:friend', value: { sessions: [a.code] } });
  assert.equal((await friend.request('/groups')).data.groups.length, 2);
  await friend.request('/groups/join', { code: a.code, penaltyCents: 500 });
  assert.equal(store.get(`session:${a.code}:meta`).members.length, 2);
  const updated = store.get(`session:${a.code}:meta`);
  updated.members[1].active = false;
  assert.equal((await owner.request('/storage/set', { key: `session:${a.code}:meta`, value: updated })).status, 200);
  assert.deepEqual((await friend.request('/groups')).data.groups.map(s => s.code), [b.code]);
  assert.equal((await friend.request(`/storage/get?key=session:${a.code}:meta`)).status, 403);
  assert.equal((await friend.request('/groups/join', { code: a.code, penaltyCents: 500 })).status, 200);
  assert.equal((await friend.request('/groups')).data.groups.length, 2);
});

test('private credentials/storage cannot be read, forged or reset through the old API', async t => {
  const { device } = await fixture(t);
  const anonymous = device();
  for (const route of ['/storage/entries', '/storage/list', '/storage/get?key=user:owner']) assert.equal((await anonymous.request(route)).status, 401);
  assert.equal((await anonymous.request('/storage/reset-demo', {})).status, 401);
  const owner = device(), outsider = device();
  await owner.request('/auth/register', { username: 'owner', password });
  await outsider.request('/auth/register', { username: 'outsider', password });
  const group = (await owner.request('/groups/create', { name: 'Private group', penaltyCents: 500 })).data.session;
  assert.equal((await outsider.request('/storage/set', { key: 'user:owner', value: { passwordHash: 'evil' } })).status, 403);
  assert.equal((await outsider.request('/storage/get?key=user:owner')).status, 403);
  assert.equal((await outsider.request('/storage/set', { key: `session:${group.code}:meta`, value: { ...group, adminUser: 'outsider' } })).status, 403);
  const entries = (await owner.request('/storage/entries')).data.entries;
  assert.ok(!Object.keys(entries).some(k => k.startsWith('auth:')));
  assert.equal(JSON.parse(entries['user:owner']).passwordHash, undefined);
  assert.equal(JSON.parse(entries['user:owner']).pinHash, null);
  assert.equal((await owner.request('/storage/reset-demo', {})).status, 404);
});

test('legacy ids assigned once; mismatched ids and inactive memberships do not grant access', async t => {
  const profile: any = legacy(); delete profile.id;
  const { device } = await fixture(t, { 'user:sepehr': profile, 'session:ABC234:meta': group(), 'session:ABC235:meta': { ...group(false), code: 'ABC235' }, 'session:ABC236:meta': { ...group(true, 'different-user-id'), code: 'ABC236' } });
  const first = device();
  const migrated = await first.request('/auth/migrate', { username: 'sepehr', password, proof: migrationToken('sepehr', secret, Date.now() + 60000) });
  assert.equal(migrated.status, 200);
  assert.ok(migrated.data.profile.id);
  assert.deepEqual(migrated.data.profile.sessions, ['ABC234']);
  const second = await device().request('/auth/login', { username: 'sepehr', password });
  assert.equal(second.data.profile.id, migrated.data.profile.id);
});

test('bad storage is never silently reset; failed writes do not update memory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'train-store-'));
  try {
    const file = path.join(dir, 'data.json');
    fs.writeFileSync(file, 'invalid');
    assert.throws(() => new Store(file));
    fs.writeFileSync(file, '{}');
    const store = new Store(file);
    store.commit({ original: { important: true } });
    fs.mkdirSync(`${file}.tmp`);
    assert.throws(() => store.commit({ original: { important: false } }));
    assert.equal(store.get('original').important, true);
    assert.equal(new Store(file).get('original').important, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('login attempts are rate limited', async t => {
  const { device } = await fixture(t);
  const d = device();
  for (let i = 0; i < 30; i++) assert.equal((await d.request('/auth/login', { username: 'nobody', password })).status, 401);
  assert.equal((await d.request('/auth/login', { username: 'nobody', password })).status, 429);
});
