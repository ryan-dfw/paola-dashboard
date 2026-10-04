// Minimal Firebase Auth admin client over the Identity Toolkit REST API —
// just the four calls this dashboard needs (look up, create, delete a user).
// Replaces the firebase-admin SDK, whose transitive dependency jwks-rsa
// require()s the ESM-only jose@6 and crashes Netlify Functions.
//
// Authenticated with the service account in FIREBASE_CLIENT_EMAIL /
// FIREBASE_PRIVATE_KEY (OAuth 2.0 JWT-bearer grant, token cached ~1h).
// Against the Auth emulator, uses the emulator's "Bearer owner" admin token.

import { importPKCS8, SignJWT } from 'jose';
import type { ServerConfig } from './env';
import { emulatorAllowed } from './firebaseToken';
import { HttpError } from './http';

export interface FirebaseUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  disabled: boolean;
  lastSignIn: string | null; // ISO
  /** Tokens issued (auth_time) before this many epoch seconds are revoked. */
  validSince: number | null;
}

export class FirebaseAdminError extends Error {
  constructor(
    public code: 'user-not-found' | 'email-exists' | 'request-failed',
    message: string,
  ) {
    super(message);
  }
}

export interface FirebaseAdmin {
  getUser(uid: string): Promise<FirebaseUser>;
  getUserByEmail(email: string): Promise<FirebaseUser>;
  createUser(input: { email: string; emailVerified: boolean }): Promise<{ uid: string }>;
  deleteUser(uid: string): Promise<void>;
}

const SCOPES = 'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform';
let tokenCache: { key: string; token: string; expiresAt: number } | null = null;

async function serviceAccountToken(sa: NonNullable<ServerConfig['serviceAccount']>, fetchImpl: typeof fetch): Promise<string> {
  if (tokenCache && tokenCache.key === sa.clientEmail && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  if (/^-----BEGIN [A-Z ]+-----$/.test(sa.privateKey.trim())) {
    // Classic .env mistake: the multi-line PEM was pasted unquoted, so only its first line was read.
    throw new HttpError(
      500,
      'config_invalid',
      'FIREBASE_PRIVATE_KEY only contains its first line. In .env, put the whole key on ONE line in double quotes, with \\n between lines.',
    );
  }
  let key: CryptoKey;
  try {
    key = await importPKCS8(sa.privateKey, 'RS256');
  } catch {
    throw new HttpError(500, 'config_invalid', 'FIREBASE_PRIVATE_KEY is not a valid PEM private key.');
  }
  const nowS = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: SCOPES })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.clientEmail)
    .setSubject(sa.clientEmail)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(nowS)
    .setExpirationTime(nowS + 3600)
    .sign(key);
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new FirebaseAdminError('request-failed', `Google refused the service account: ${body.error_description || res.status}`);
  }
  tokenCache = { key: sa.clientEmail, token: body.access_token, expiresAt: Date.now() + ((body.expires_in ?? 3600) - 120) * 1000 };
  return body.access_token;
}

interface RawUser {
  localId: string;
  email?: string;
  emailVerified?: boolean;
  disabled?: boolean;
  lastLoginAt?: string; // ms
  validSince?: string; // s
}

function toUser(u: RawUser): FirebaseUser {
  return {
    uid: u.localId,
    email: u.email ?? null,
    emailVerified: Boolean(u.emailVerified),
    disabled: Boolean(u.disabled),
    lastSignIn: u.lastLoginAt ? new Date(Number(u.lastLoginAt)).toISOString() : null,
    validSince: u.validSince ? Number(u.validSince) : null,
  };
}

/** Returns null when neither service-account credentials nor the emulator are available. */
export function firebaseAdmin(config: ServerConfig, fetchImpl: typeof fetch = fetch): FirebaseAdmin | null {
  const projectId = config.firebaseProjectId;
  if (!projectId) return null;
  const emulator = emulatorAllowed() ? process.env.FIREBASE_AUTH_EMULATOR_HOST : undefined;
  if (!emulator && !config.serviceAccount) return null;

  const base = emulator
    ? `http://${emulator}/identitytoolkit.googleapis.com/v1/projects/${projectId}`
    : `https://identitytoolkit.googleapis.com/v1/projects/${projectId}`;

  async function call<T>(path: string, body: unknown): Promise<T> {
    const bearer = emulator ? 'owner' : await serviceAccountToken(config.serviceAccount!, fetchImpl);
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) {
      const msg = json.error?.message || `HTTP ${res.status}`;
      if (msg.startsWith('EMAIL_EXISTS') || msg.startsWith('DUPLICATE_EMAIL')) throw new FirebaseAdminError('email-exists', msg);
      if (msg.startsWith('USER_NOT_FOUND')) throw new FirebaseAdminError('user-not-found', msg);
      throw new FirebaseAdminError('request-failed', `Firebase Auth: ${msg}`);
    }
    return json;
  }

  async function lookup(body: { localId: string[] } | { email: string[] }): Promise<FirebaseUser> {
    const r = await call<{ users?: RawUser[] }>('/accounts:lookup', body);
    const u = r.users?.[0];
    if (!u) throw new FirebaseAdminError('user-not-found', 'No user record.');
    return toUser(u);
  }

  return {
    getUser: (uid) => lookup({ localId: [uid] }),
    getUserByEmail: (email) => lookup({ email: [email] }),
    async createUser({ email, emailVerified }) {
      const r = await call<{ localId: string }>('/accounts', { email, emailVerified });
      return { uid: r.localId };
    },
    async deleteUser(uid) {
      await call('/accounts:delete', { localId: uid });
    },
  };
}
