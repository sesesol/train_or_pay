# Review of the current main branch

Based on commit `951ddb0` (the new SSE live-update implementation). Earlier
password PR #4 is closed and unmerged; this follow-up preserves the current
main branch instead of silently reintroducing that closed proposal.

## Fixed

- File writes use a temporary file and atomic replacement. In-memory state
  changes only after successful persistence. A damaged data file stops startup
  instead of silently starting an empty store. Failed API writes return errors.
- Client reads distinguish a genuine 404 from network/500 errors. Storage errors
  no longer masquerade as an absent account, empty group or successful deletion.
  Removed local-cache/host-storage fallbacks that could mix separate datasets.
- Group listing requires active membership instead of trusting stale profile
  codes. Rejoining an existing group repairs the profile index and group list.
- The SSE stream sends only group-key invalidation hints, never record values
  or user-profile events. Slow/disconnected clients are removed and heartbeat
  timers cleaned up. Reconnection triggers a full refresh.
- Superseded refreshes cannot apply their final state over a newer refresh;
  logout invalidates pending refreshes. Local workout writes increment a version
  to prevent an older read from overwriting a write that has just completed.
- Background polling is bounded to one in-flight poll, every 15 seconds, while
  SSE retains quick updates. Focus/tab visibility still trigger refreshes.
- Missing/invalid login expiration dates are rejected instead of being permanent.
- Removed the public global reset operation. Removed the empty runtime data file
  from version control and ignored future runtime files; no actual user records
  were present in the committed file examined in this review.
- Production uses the production server path and respects the hosting PORT.

## Not resolved by this patch

**Authentication remains a production blocker.** Main still has the legacy
optional client-verified PIN and unprotected storage endpoints. SSE hints also
remain unauthenticated and expose group key names (not values). This patch is
not a security sign-off. The password and authorization design in closed PR #4
needs an explicit follow-up aligned with the live-update implementation.

**Cloud Run durability remains a production blocker.** `STORAGE_DATA_FILE` is
useful only when it points to a genuinely persistent volume. A local path in
an AI Studio/Cloud Run container is not a shared database. Deploying multiple
instances still gives separate in-memory snapshots and local SSE connections.
Use a transactional shared database such as Firestore and shared update
notifications before relying on multi-instance hosting. No cloud database was
provisioned by this patch, and no live deployment was performed.

Concurrent read-modify-write operations on groups, accounts, settlements and
debts still require database transactions/server-side domain operations. Atomic
file replacement prevents partial files; it does not solve application-level
lost updates between separate requests. The settlement/financial model was not
redesigned in this review.

## Rollout and validation

Back up the actual server data before applying this change. The server now
consistently uses its storage API; data available only through a host-provided
`window.storage` needs to be exported from that host separately. Browser caches
are not used as authoritative account data. Do not overwrite existing server
data with an empty file from an older repository checkout.

Use the existing Bun lockfile for a reproducible dependency install, then run:

```sh
npm test
npm run lint
npm run build
```

Regression tests cover file reload/deletion, failed writes, malformed data,
prototype-like keys, SSE payloads and slow clients, network/HTTP failures,
malformed batches, invalid login dates, and stream cleanup. Tests do not access
production records. Browser UI and real hosting configuration were not tested.
