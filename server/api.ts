import express from 'express';
import { randomBytes, randomUUID, randomInt } from 'node:crypto';
import { Store } from './store.ts';
import { digest, equal, hashPassword, normalizeUsername, verifyMigrationToken, verifyPassword } from './auth.ts';
import { getBerlinISOWeek, getBerlinParts } from '../src/lib/time.ts';

const COOKIE = 'train_or_pay_session';
const TTL = 60 * 24 * 60 * 60 * 1000;
const usernameValid = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9äöüÄÖÜß_\- ]{3,20}$/.test(s.trim());
const passwordValid = (s: unknown): s is string => typeof s === 'string' && s.length >= 12 && s.length <= 128;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export function createApi(store: Store, options: { secureCookies?: boolean; migrationSecret?: string } = {}) {
  const api = express.Router();
  api.use(express.json({ limit: '10mb' }));
  api.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  // Browser writes must be same-origin. JSON-only POSTs also prevent simple cross-site form requests.
  api.use((req, _res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.headers['sec-fetch-site'] === 'cross-site') return next(fail(403, 'Unzulässige Anfrage.'));
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return next(fail(403, 'Unzulässige Anfrage.'));
      if (req.method === 'POST' && !req.is('application/json')) return next(fail(415, 'JSON erforderlich.'));
    }
    next();
  });
  const attempts = new Map<string, { count: number; until: number }>();
  api.use('/auth', (req, _res, next) => {
    if (req.method !== 'POST' || req.path === '/logout') return next();
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const keys = [`ip:${req.ip}`, `user:${typeof req.body.username === 'string' ? normalizeUsername(req.body.username) : ''}`];
    for (const key of keys) {
      const attempt = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
      attempt.count++;
      attempts.set(key, attempt);
      if (attempt.count > 30) return next(fail(429, 'Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.'));
    }
    next();
  });
  function publicProfile(profile: any) {
    const { passwordHash, pinHash, ...safe } = profile;
    return { ...safe, pinHash: null };
  }
  function groups(username: string, id: string) {
    return Object.keys(store.data).filter(k => /^session:[^:]+:meta$/.test(k)).map(k => store.get(k))
      .filter(s => s?.members?.some(m => m.active && (m.userId ? m.userId === id : m.user.toLowerCase() === username)));
  }
  function profileWithGroups(username: string, profile: any) {
    return { ...profile, sessions: groups(username, profile.id).map(s => s.code) };
  }
  function cookie(req: express.Request) {
    return req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
  }
  function issueSession(req: express.Request, res: express.Response, username: string, profile: any) {
    const token = randomBytes(32).toString('base64url');
    const updated = profileWithGroups(username, { ...profile, id: profile.id || randomUUID() });
    const expired = Object.keys(store.data).filter(k => k.startsWith('auth:') && store.get(k)?.expiresAt <= Date.now());
    if (cookie(req)) expired.push(`auth:${digest(cookie(req))}`);
    store.commit({ [`user:${username}`]: updated, [`auth:${digest(token)}`]: { username, userId: updated.id, expiresAt: Date.now() + TTL } }, expired);
    res.cookie(COOKIE, token, { httpOnly: true, secure: options.secureCookies ?? req.secure, sameSite: 'lax', path: '/', maxAge: TTL });
    res.json({ profile: publicProfile(updated), usernameLower: username });
  }
  api.post('/auth/register', (req, res) => {
    const { username, password } = req.body;
    if (!usernameValid(username) || !passwordValid(password)) throw fail(400, 'Benutzername: 3–20 Zeichen. Passwort: 12–128 Zeichen.');
    const lower = normalizeUsername(username);
    if (store.get(`user:${lower}`)) throw fail(409, 'Dieser Benutzername ist bereits vergeben. Bitte anmelden oder das bestehende Konto umstellen.');
    issueSession(req, res, lower, { id: randomUUID(), displayName: username.trim(), passwordHash: hashPassword(password), pinHash: null, createdAt: new Date().toISOString(), sessions: [] });
  });
  api.post('/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!usernameValid(username) || typeof password !== 'string' || password.length > 128) throw fail(401, 'Benutzername oder Passwort falsch.');
    const lower = normalizeUsername(username), profile = store.get(`user:${lower}`);
    if (!profile?.passwordHash || !verifyPassword(password, profile.passwordHash)) throw fail(401, 'Benutzername oder Passwort falsch. Altes Konto? Nutze „Bestehendes Konto umstellen“.');
    issueSession(req, res, lower, profile);
  });
  api.post('/auth/migrate', (req, res) => {
    const { username, password, proof } = req.body;
    if (!usernameValid(username) || !passwordValid(password) || typeof proof !== 'string' || proof.length > 1024) throw fail(400, 'Bitte Benutzername, Nachweis und ein Passwort mit 12–128 Zeichen eingeben.');
    const lower = normalizeUsername(username), profile = store.get(`user:${lower}`);
    // A localStorage user-id is public data, never proof of account ownership.
    const valid = profile && !profile.passwordHash && (profile.pinHash ? equal(proof, profile.pinHash) : verifyMigrationToken(proof, lower, options.migrationSecret));
    if (!valid) throw fail(401, 'Umstellung nicht möglich. Alte PIN bzw. persönlichen Umstellungscode prüfen. Bereits umgestellte Konten bitte normal anmelden.');
    issueSession(req, res, lower, { ...profile, passwordHash: hashPassword(password), pinHash: null });
  });
  api.post('/auth/logout', (req, res) => {
    store.commit({}, [`auth:${digest(cookie(req))}`]);
    res.clearCookie(COOKIE, { httpOnly: true, secure: options.secureCookies ?? req.secure, sameSite: 'lax', path: '/' });
    res.json({ success: true });
  });
  api.use((req, res, next) => {
    const auth = store.get(`auth:${digest(cookie(req))}`);
    const profile = auth && store.get(`user:${auth.username}`);
    if (!auth || auth.expiresAt <= Date.now() || !profile?.passwordHash || profile.id !== auth.userId) return next(fail(401, 'Bitte erneut anmelden.'));
    res.locals.username = auth.username;
    res.locals.profile = profile;
    next();
  });
  api.get('/auth/me', (_req, res) => res.json({ profile: publicProfile(profileWithGroups(res.locals.username, res.locals.profile)), usernameLower: res.locals.username }));
  api.get('/groups', (_req, res) => res.json({ groups: groups(res.locals.username, res.locals.profile.id) }));
  api.post('/groups/create', (req, res) => {
    const { name, penaltyCents } = req.body;
    if (typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 40 || !Number.isInteger(penaltyCents) || penaltyCents < 50 || penaltyCents > 5000) throw fail(400, 'Bitte einen Gruppennamen und gültigen Strafsatz eingeben.');
    const chars = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    let code: string;
    do { code = Array.from({ length: 6 }, () => chars[randomInt(chars.length)]).join(''); } while (store.get(`session:${code}:meta`));
    const { username, profile } = res.locals;
    const session = { code, name: name.trim(), createdAt: new Date().toISOString(), adminUser: username,
      members: [{ user: username, userId: profile.id, displayName: profile.displayName, joinedAt: new Date().toISOString(), penaltyCents, active: true }], settings: { allowMultiplePerDay: false } };
    store.commit({ [`session:${code}:meta`]: session, [`user:${username}`]: { ...profile, sessions: [...groups(username, profile.id).map(s => s.code), code] } });
    res.json({ session });
  });
  api.post('/groups/join', (req, res) => {
    const code = typeof req.body.code === 'string' ? req.body.code.trim().toUpperCase() : '';
    if (!/^[A-Z0-9]{6}$/.test(code)) throw fail(400, 'Bitte einen gültigen Gruppencode eingeben.');
    const session = store.get(`session:${code}:meta`);
    if (!session) throw fail(404, 'Diese Gruppe wurde nicht gefunden. Bitte den Code und die verwendete App-Adresse prüfen.');
    const { username, profile } = res.locals;
    const member = session.members.find(m => m.user.toLowerCase() === username);
    if (member?.userId && member.userId !== profile.id) throw fail(403, 'Die Mitgliedschaft gehört zu einem anderen Konto.');
    if (!member?.active && session.members.filter(m => m.active).length >= 20) throw fail(409, 'Diese Gruppe ist voll.');
    const penalty = req.body.penaltyCents;
    if (!member && (!Number.isInteger(penalty) || penalty < 50 || penalty > 5000)) throw fail(400, 'Ungültiger Strafsatz.');
    const wasActive = member?.active;
    if (member) { member.active = true; member.userId = profile.id; }
    else session.members.push({ user: username, userId: profile.id, displayName: profile.displayName, active: true, joinedAt: new Date().toISOString(), penaltyCents: penalty });
    const updates: Record<string, any> = { [`session:${code}:meta`]: session, [`user:${username}`]: { ...profile, sessions: [...new Set([...groups(username, profile.id).map(s => s.code), code])] } };
    const weekKey = `session:${code}:week:${getBerlinISOWeek(new Date())}:user:${username}`;
    if (!wasActive && !store.get(weekKey) && getBerlinParts(new Date()).dayOfWeek > 1) updates[weekKey] = { goal: 0, checks: [], penaltyCentsSnapshot: member?.penaltyCents ?? penalty, joinedMidWeek: true, lockedAt: new Date().toISOString() };
    store.commit(updates);
    res.json({ session });
  });
  function canRead(key: string, res: express.Response) {
    if (key === `user:${res.locals.username}`) return true;
    const match = /^session:([^:]+):/.exec(key);
    return Boolean(match && groups(res.locals.username, res.locals.profile.id).some(s => s.code === match[1]));
  }
  function visible(key: string) {
    const value = store.get(key);
    return key.startsWith('user:') ? publicProfile(value) : value;
  }
  api.get('/storage/get', (req, res) => {
    const key = String(req.query.key || '');
    if (!canRead(key, res)) throw fail(403, 'Kein Zugriff auf diese Daten.');
    if (!Object.hasOwn(store.data, key)) throw fail(404, 'Eintrag nicht gefunden.');
    res.json({ key, value: JSON.stringify(visible(key)) });
  });
  for (const route of ['entries', 'list']) api.get(`/storage/${route}`, (req, res) => {
    const prefix = String(req.query.prefix || ''), suffix = String(req.query.suffix || '');
    const keys = Object.keys(store.data).filter(k => k.startsWith(prefix) && k.endsWith(suffix) && canRead(k, res));
    res.json(route === 'list' ? { keys } : { entries: Object.fromEntries(keys.map(k => [k, JSON.stringify(visible(k))])) });
  });
  api.post('/storage/set', (req, res) => {
    const { key } = req.body;
    const value = typeof req.body.value === 'string' ? JSON.parse(req.body.value) : req.body.value;
    if (typeof key !== 'string' || !value || typeof value !== 'object') throw fail(400, 'Ungültiger Eintrag.');
    const { username, profile } = res.locals;
    if (key === `user:${username}`) {
      // Client profile snapshots may be stale. Identity, credentials and memberships belong to the server.
      store.commit({ [key]: profileWithGroups(username, profile) });
    } else {
      const metaMatch = /^session:([A-Z0-9]{6}):meta$/.exec(key);
      if (metaMatch) {
        const previous = store.get(key);
        if (value.code !== metaMatch[1] || !Array.isArray(value.members) || typeof value.name !== 'string' || value.name.trim().length < 3 || value.name.length > 40) throw fail(400, 'Ungültige Gruppe.');
        if (!previous) {
          throw fail(403, 'Neue Gruppen bitte über die Gruppenerstellung anlegen.');
        } else {
          if (!canRead(key, res)) throw fail(403, 'Keine Mitgliedschaft.');
          // Membership additions only through the atomic join endpoint; existing identities never change.
          if (value.members.length !== previous.members.length || new Set(value.members.map(m => m.user)).size !== value.members.length || value.members.some(m => !previous.members.some(p => p.user === m.user && p.userId === m.userId))) throw fail(403, 'Mitglieder können nur über einen Gruppencode beitreten.');
          if (previous.adminUser !== username) {
            if (value.name !== previous.name || value.adminUser !== previous.adminUser || JSON.stringify(value.settings) !== JSON.stringify(previous.settings) || value.members.some(m => m.user !== username && JSON.stringify(m) !== JSON.stringify(previous.members.find(p => p.user === m.user)))) throw fail(403, 'Nur der Gruppenadmin kann diese Einstellungen ändern.');
          }
        }
        if (!value.members.some(m => m.user === value.adminUser && m.active)) throw fail(400, 'Die Gruppe benötigt einen aktiven Admin.');
        store.commit({ [key]: value });
      } else {
        if (!canRead(key, res) || !key.startsWith('session:')) throw fail(403, 'Kein Schreibzugriff.');
        store.commit({ [key]: value });
      }
    }
    res.json({ success: true });
  });
  api.delete('/storage/delete', (req, res) => {
    const key = String(req.query.key || ''), match = /^session:([^:]+):/.exec(key);
    const session = match && store.get(`session:${match[1]}:meta`);
    if (!session || session.adminUser !== res.locals.username || !canRead(key, res)) throw fail(403, 'Nur der Gruppenadmin kann diese Daten löschen.');
    const keys = key.endsWith(':meta') ? Object.keys(store.data).filter(k => k.startsWith(`session:${session.code}:`)) : [key];
    store.commit({}, keys);
    res.json({ success: true });
  });
  api.use((_req, _res, next) => next(fail(404, 'API-Endpunkt nicht gefunden.')));
  api.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (!err.status) console.error('API request failed:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Serverfehler. Daten konnten nicht geladen oder gespeichert werden. Bitte erneut versuchen.' });
  });
  return api;
}
