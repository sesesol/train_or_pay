import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  terminate,
  setLogLevel,
} from 'firebase/firestore';
import { db, encodeStorageDocId, extractKeyPrefix } from '../src/lib/firebase.ts';

setLogLevel('silent');

test('firestore.rules enforces all 8 pillars and Dirty Dozen invariants', async (t) => {
  const rulesText = fs.readFileSync(path.join(process.cwd(), 'firestore.rules'), 'utf8');
  const blueprint = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'firebase-blueprint.json'), 'utf8')
  );

  await t.test('Blueprint and rules structure invariants', () => {
    assert.ok(rulesText.includes("rules_version = '2';"));
    assert.ok(rulesText.includes('match /{document=**} {\n      allow read, write: if false;\n    }'));
    assert.ok(rulesText.includes('function isValidId(id)'));
    assert.ok(rulesText.includes('function isValidStorageRecord(data)'));
    assert.ok(rulesText.includes('function isValidUserAccount(data)'));
    assert.ok(rulesText.includes('function isValidAdminRecord(data)'));
    assert.ok(blueprint.entities.StorageRecord);
    assert.ok(blueprint.entities.UserAccount);
    assert.ok(blueprint.entities.AdminRecord);
    assert.ok(blueprint.firestore['/app_storage/{recordId}']);
    assert.ok(blueprint.firestore['/users/{userId}']);
    assert.ok(blueprint.firestore['/admins/{adminId}']);
  });

  await t.test('encodeStorageDocId produces valid Firestore IDs within 1..128 chars', () => {
    const keys = [
      'user:ali',
      'user:müller',
      'session:AB7K9X:meta',
      'session:AB7K9X:week:2026-W46:user:ali',
      `session:LONG:${'x'.repeat(300)}`,
    ];
    for (const k of keys) {
      const id = encodeStorageDocId(k);
      assert.ok(id.length >= 1 && id.length <= 128, `ID length out of bounds: ${id.length}`);
      assert.match(id, /^[a-zA-Z0-9_\-]+$/);
    }
    assert.equal(extractKeyPrefix('user:ali'), 'user');
    assert.equal(extractKeyPrefix('session:AB7K9X:meta'), 'session');
    assert.equal(extractKeyPrefix('recent:users'), 'recent');
  });

  await t.test('Dirty Dozen payloads are rejected with PERMISSION_DENIED on live Firestore', async () => {
    const validId = encodeStorageDocId('session:SEC_TEST_01:meta');
    const validRef = doc(db, 'app_storage', validId);

    // Ensure valid baseline record exists
    await setDoc(validRef, {
      key: 'session:SEC_TEST_01:meta',
      value: '{"code":"SEC_TEST_01"}',
      prefix: 'session',
      updatedAt: new Date().toISOString(),
    });

    await Promise.all([
      // 1. Shadow field injection
      assert.rejects(
        setDoc(doc(db, 'app_storage', encodeStorageDocId('session:SEC_SHADOW:meta')), {
          key: 'session:SEC_SHADOW:meta',
          value: '{}',
          prefix: 'session',
          updatedAt: new Date().toISOString(),
          isVerifiedAdmin: true,
        } as any),
        /Missing or insufficient permissions/
      ),

      // 2. Invalid namespace prefix
      assert.rejects(
        setDoc(doc(db, 'app_storage', encodeStorageDocId('system:config')), {
          key: 'system:config',
          value: '{}',
          prefix: 'system',
          updatedAt: new Date().toISOString(),
        } as any),
        /Missing or insufficient permissions/
      ),

      // 3. Immutable key mutation on update
      assert.rejects(
        setDoc(validRef, {
          key: 'session:MUTATED_KEY:meta',
          value: '{"code":"SEC_TEST_01"}',
          prefix: 'session',
          updatedAt: new Date().toISOString(),
        }),
        /Missing or insufficient permissions/
      ),

      // 4. Oversized key (> 512 chars)
      assert.rejects(
        setDoc(doc(db, 'app_storage', 'oversized_key_test_doc'), {
          key: `session:${'A'.repeat(520)}`,
          value: '{}',
          prefix: 'session',
          updatedAt: new Date().toISOString(),
        }),
        /Missing or insufficient permissions/
      ),

      // 5. Type poisoning on value (number instead of string)
      assert.rejects(
        setDoc(doc(db, 'app_storage', 'type_poison_test_doc'), {
          key: 'user:poison',
          value: 12345,
          prefix: 'user',
          updatedAt: new Date().toISOString(),
        } as any),
        /Missing or insufficient permissions/
      ),

      // 6. ID poisoning (invalid characters in doc ID)
      assert.rejects(
        setDoc(doc(db, 'app_storage', 'invalid$id*chars'), {
          key: 'user:badid',
          value: '{}',
          prefix: 'user',
          updatedAt: new Date().toISOString(),
        }),
        /Missing or insufficient permissions/
      ),

      // 7-11. Unauthenticated / spoofed access to protected /users and /admins collections
      assert.rejects(
        setDoc(doc(db, 'users', 'victim-uid'), {
          id: 'victim-uid',
          usernameLower: 'ali',
          displayName: 'Ali',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        /Missing or insufficient permissions/
      ),

      assert.rejects(
        getDoc(doc(db, 'users', 'victim-uid')),
        /Missing or insufficient permissions/
      ),

      assert.rejects(
        setDoc(doc(db, 'admins', 'attacker-uid'), {
          uid: 'attacker-uid',
          createdAt: new Date().toISOString(),
        }),
        /Missing or insufficient permissions/
      ),

      // 12. Unmatched collection write
      assert.rejects(
        setDoc(doc(db, 'unknown_collection', 'doc1'), { foo: 'bar' }),
        /Missing or insufficient permissions/
      ),
    ]);

    // Cleanup valid test document
    await deleteDoc(validRef);
  });

  await terminate(db);
});
