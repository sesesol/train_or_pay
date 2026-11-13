/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  collection,
  query,
  where,
  onSnapshot,
  getDocFromServer,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  testConnection();
}

/**
 * Deterministically encode any logical storage key into a valid Firestore document ID
 * matching ^[a-zA-Z0-9_\-]+$ with length between 1 and 128 characters.
 */
export function encodeStorageDocId(key: string): string {
  const bytes = new TextEncoder().encode(key);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64Url = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (base64Url.length <= 120) {
    return base64Url || 'empty';
  }
  // Deterministic 64-bit FNV-1a-style hash suffix for keys whose base64 exceeds 120 chars
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= bytes[bytes.length - 1 - i];
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return `${base64Url.slice(0, 96)}-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export function extractKeyPrefix(key: string): 'user' | 'session' | 'recent' {
  if (key.startsWith('user:')) return 'user';
  if (key.startsWith('session:')) return 'session';
  return 'recent';
}

export interface StorageRecordDoc {
  key: string;
  value: string;
  prefix: 'user' | 'session' | 'recent';
  updatedAt: string;
}

const COLLECTION_NAME = 'app_storage';

export async function firestoreGetRecord(key: string): Promise<string | undefined> {
  const docId = encodeStorageDocId(key);
  const path = `${COLLECTION_NAME}/${docId}`;
  try {
    const snap = await getDoc(doc(db, COLLECTION_NAME, docId));
    if (!snap.exists()) return undefined;
    const data = snap.data() as StorageRecordDoc;
    return typeof data?.value === 'string' ? data.value : undefined;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function firestoreSetRecord(key: string, value: string): Promise<void> {
  const docId = encodeStorageDocId(key);
  const path = `${COLLECTION_NAME}/${docId}`;
  const payload: StorageRecordDoc = {
    key: key.slice(0, 512),
    value,
    prefix: extractKeyPrefix(key),
    updatedAt: new Date().toISOString(),
  };
  try {
    await setDoc(doc(db, COLLECTION_NAME, docId), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function firestoreDeleteRecord(key: string): Promise<boolean> {
  const docId = encodeStorageDocId(key);
  const path = `${COLLECTION_NAME}/${docId}`;
  try {
    const ref = doc(db, COLLECTION_NAME, docId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return false;
    await deleteDoc(ref);
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function firestoreQueryEntries(
  prefix = '',
  suffix = ''
): Promise<Record<string, string>> {
  const path = COLLECTION_NAME;
  try {
    const q =
      prefix.startsWith('session:')
        ? query(collection(db, COLLECTION_NAME), where('prefix', '==', 'session'))
        : prefix.startsWith('user:')
          ? query(collection(db, COLLECTION_NAME), where('prefix', '==', 'user'))
          : prefix.startsWith('recent:')
            ? query(collection(db, COLLECTION_NAME), where('prefix', '==', 'recent'))
            : query(
                collection(db, COLLECTION_NAME),
                where('prefix', 'in', ['user', 'session', 'recent'])
              );

    const snap = await getDocs(q);
    const out: Record<string, string> = {};
    snap.forEach((docSnap) => {
      const data = docSnap.data() as StorageRecordDoc;
      if (
        data &&
        typeof data.key === 'string' &&
        typeof data.value === 'string' &&
        data.key.startsWith(prefix) &&
        data.key.endsWith(suffix)
      ) {
        out[data.key] = data.value;
      }
    });
    return out;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export function subscribeFirestoreChanges(
  onKeyChanged: (key: string, value?: string, deleted?: boolean) => void,
  onStatus?: (connected: boolean) => void
): () => void {
  const q = query(
    collection(db, COLLECTION_NAME),
    where('prefix', 'in', ['user', 'session', 'recent'])
  );
  let initialLoad = true;
  return onSnapshot(
    q,
    (snapshot) => {
      onStatus?.(true);
      if (initialLoad) {
        initialLoad = false;
        snapshot.docChanges().forEach((change) => {
          const data = change.doc.data() as StorageRecordDoc;
          if (data && typeof data.key === 'string') {
            onKeyChanged(data.key, data.value, change.type === 'removed');
          }
        });
        return;
      }
      snapshot.docChanges().forEach((change) => {
        const data = change.doc.data() as StorageRecordDoc;
        if (data && typeof data.key === 'string') {
          onKeyChanged(data.key, data.value, change.type === 'removed');
        }
      });
    },
    (error) => {
      onStatus?.(false);
      try {
        handleFirestoreError(error, OperationType.LIST, COLLECTION_NAME);
      } catch (_logged) {
        // Error is logged in structured FirestoreErrorInfo format by handleFirestoreError
      }
    }
  );
}
