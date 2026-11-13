# Security Specification (`security_spec.md`)

## 1. Data Invariants

1. **Default Deny Catch-All**: Every path not explicitly matched under `/databases/{database}/documents` is unconditionally denied (`allow read, write: if false;`).
2. **Path Variable Hardening (`isValidId`)**: Every document ID (`{recordId}`, `{userId}`, `{adminId}`) on single-document operations (`get`, `create`, `update`, `delete`) must be a string between 1 and 128 characters matching `^[a-zA-Z0-9_\-]+$`.
3. **StorageRecord Schema Integrity (`isValidStorageRecord`)**:
   - Allowed and required keys on create: `['key', 'value', 'prefix', 'updatedAt']` (`hasAll` and `hasOnly`).
   - `key` must be a string with `1 <= size() <= 512`.
   - `value` must be a string with `1 <= size() <= 900000`.
   - `prefix` must be a string in `['user', 'session', 'recent']` with `1 <= size() <= 64`.
   - `updatedAt` must be a string with `10 <= size() <= 64`.
   - On update, `key` and `prefix` are immutable (`incoming().key == existing().key && incoming().prefix == existing().prefix`) and only `['value', 'updatedAt']` or `['key', 'value', 'prefix', 'updatedAt']` with identical `key`/`prefix` may be modified.
4. **UserAccount Identity & PII Isolation (`isValidUserAccount`)**:
   - Read (`get`, `list`) restricted strictly to the document owner (`request.auth.uid == userId` / `resource.data.id == request.auth.uid`) or verified admin (`isAdmin()`).
   - Required and allowed keys: `['id', 'usernameLower', 'displayName', 'createdAt', 'updatedAt']`.
   - `id` must equal `request.auth.uid` and `userId`, and is immutable on update.
   - `createdAt` must equal `request.time` on create and remain immutable on update.
   - `updatedAt` must equal `request.time` on create and update.
5. **Admin Registry Lockdown (`/admins/{adminId}`)**:
   - Only existing verified admins or the bootstrapped runtime admin (`sepehr.soleimani76@gmail.com` with `email_verified == true`) can read or write admin documents.

---

## 2. The "Dirty Dozen" Payloads

1. **Payload 1 (Shadow Field Injection on StorageRecord)**:
   ```json
   {
     "key": "session:AB7K9X:meta",
     "value": "{\"code\":\"AB7K9X\"}",
     "prefix": "session",
     "updatedAt": "2026-11-11T12:00:00.000Z",
     "isVerifiedAdmin": true
   }
   ```
2. **Payload 2 (Invalid Namespace Prefix on StorageRecord)**:
   ```json
   {
     "key": "system:config",
     "value": "{}",
     "prefix": "system",
     "updatedAt": "2026-11-11T12:00:00.000Z"
   }
   ```
3. **Payload 3 (Immutable Key Mutation on StorageRecord Update)**:
   ```json
   {
     "key": "session:HACKED:meta",
     "value": "{}",
     "prefix": "session",
     "updatedAt": "2026-11-11T12:01:00.000Z"
   }
   ```
4. **Payload 4 (Oversized Key / Resource Exhaustion on StorageRecord)**:
   ```json
   {
     "key": "<string of length 600>",
     "value": "{}",
     "prefix": "session",
     "updatedAt": "2026-11-11T12:00:00.000Z"
   }
   ```
5. **Payload 5 (Type Poisoning on StorageRecord Value)**:
   ```json
   {
     "key": "user:ali",
     "value": 12345,
     "prefix": "user",
     "updatedAt": "2026-11-11T12:00:00.000Z"
   }
   ```
6. **Payload 6 (ID Poisoning on Path Variable)**:
   - Document ID containing invalid characters or exceeding 128 characters (`recordId = "bad/id$with*chars"`).
7. **Payload 7 (Identity Spoofing on UserAccount Create)**:
   ```json
   {
     "id": "victim-uid",
     "usernameLower": "ali",
     "displayName": "Ali",
     "createdAt": "SERVER_TIMESTAMP",
     "updatedAt": "SERVER_TIMESTAMP"
   }
   ```
8. **Payload 8 (Unverified Email Spoofing on Admin Action)**:
   - Authenticated user with `email: "sepehr.soleimani76@gmail.com"` but `email_verified: false` attempting admin write.
9. **Payload 9 (PII / Profile Cross-User Read)**:
   - Authenticated user `attacker-uid` attempting `get` on `/users/victim-uid`.
10. **Payload 10 (Privilege Escalation via Self-Admin Creation)**:
    - Standard user `attacker-uid` attempting `create` on `/admins/attacker-uid`.
11. **Payload 11 (Immortal Field `createdAt` Tampering on UserAccount Update)**:
    - Owner attempting to modify `createdAt` during an `update` on `/users/{userId}`.
12. **Payload 12 (Unmatched Collection / Orphan Write)**:
    - Write attempt to `/unknown_collection/doc1`.

---

## 3. Test Runner

See `tests/firestore.rules.test.ts` for the automated test suite verifying all 12 Dirty Dozen payloads are rejected with `PERMISSION_DENIED`.
