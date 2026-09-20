# Trainieren oder zahlen

React/Vite frontend with an Express backend. Accounts, group memberships and
training data are shared by all devices using the **same server and data file**.

## Run locally

Requires Node.js 22+.

```sh
npm ci
npm run dev
```

Production (HTTPS):

```sh
npm ci
npm run build
npm start
```

Serve the frontend and `/api` on the same origin through the Express server.
`vite preview` and static-only hosting do not provide the account/data API.

## What changed in account access

- Register explicitly with a username and a password of 12–128 characters.
  Login never creates or overwrites an account. Username matching ignores case
  and surrounding spaces, preserving the existing username key format.
- Passwords use salted scrypt hashes and are verified on the server. Neither
  password hashes nor old PINs are returned to the frontend.
- Each device gets its own opaque HttpOnly, SameSite cookie lasting 60 days.
  Logout revokes that device's server session; other devices remain signed in.
  A new browser/device still needs one login. Browser cookie deletion also
  requires a new login, but does not remove group memberships.
- Active group memberships are loaded from the server's group records, even if
  the old profile's `sessions` list is missing/stale. Removed memberships and
  mismatched user IDs are excluded. Joining and profile updates are atomic.
- Group codes in this implementation **do not expire**. Existing members do
  not need a code again. A missing code means the group is absent on that
  server (or the code/address is incorrect), not that an expiry timer elapsed.
- Shared reads no longer silently fall back to localStorage or a host's
  `window.storage`. Connection errors are surfaced instead of showing stale
  accounts or creating an apparently new account.
- Storage access requires authentication and is limited to the user's own
  profile and groups. The old unauthenticated reset-demo route is removed.
  Existing cooperative group training/settlement editing remains in place;
  this change is not a redesign of financial permissions within a group.

## Upgrade an existing deployment without losing data

1. Stop the old server and back up its actual `.storage_data.json`. Do not
   replace it with an empty file. Data only held by a host-provided
   `window.storage` must be exported from that host first; this server cannot
   read a different host's database. Browser caches are not account proof.
2. Put the existing file on a **persistent volume** and set
   `STORAGE_DATA_FILE` to its absolute path. Without this setting the existing
   `.storage_data.json` in the working directory is still used. On hosts with
   ephemeral filesystems it will not survive replacement of the instance.
3. Run **one server process/replica** against this file, with backups. The
   file store atomically replaces data and reports failed writes, but is not
   a multi-process database. Multiple replicas or serverless deployments need
   a transactional shared database before production use. A GitHub deployment
   alone does not provision durable storage.
4. Set a random server-only `ACCOUNT_MIGRATION_SECRET` (at least 32 characters)
   if old accounts without PINs exist. For example generate one using
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
   Keep it out of Git, client bundles and `VITE_*` environment variables.
5. Build/start the new server behind HTTPS. Secure cookies are enabled by
   `npm start`. Use `COOKIE_SECURE=false` only for a local HTTP smoke test.
6. Existing users select **Bestehendes Konto umstellen** once. Old browser
   login pointers are deliberately not accepted as authentication:
   - With an old PIN: enter that PIN and a new password.
   - Without a PIN: the operator verifies the person, then generates a
     username-bound personal code on the trusted server:

     ```sh
     npm run account:migration-code -- "Sepehr"
     ```

     The script loads the same `.env` as the server (or its environment).
     The code is valid for 24 hours, works only for that username, and cannot
     be used after the account has been upgraded. Send it privately to the
     verified owner. A group invitation code cannot upgrade an account.
7. Verify with a second device: log in with the same username/password and
   check groups and historical training data. Also restart the server and
   verify that the same file, accounts, cookies and groups are still present.

Existing user IDs, username keys, training records and group records are
preserved during upgrade. Missing legacy IDs are assigned once on the server.
If the original data file was already lost, this change cannot reconstruct it;
restore an operator backup before migrating accounts. Do not register new
accounts as a substitute for restoring the original records.

There is no self-service forgotten-password recovery in this version. Do not
use new usernames to recover an existing account. Authentication attempts are
rate-limited in the server process; public deployments should also enforce
rate limits at their trusted reverse proxy.

## Verification

```sh
npm run lint
npm test
npm run build
```

API integration tests use temporary data files and isolated cookie jars for
multiple devices. They cover migration, retained IDs/history, fresh login,
missing/stale membership indexes, inactive members, authorization, logout,
expiry, rate limiting, durable reload and failed writes. Production hosting
and real user data are not accessed by the tests.
