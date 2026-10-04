// Firebase ID-token verification without firebase-admin.
//
// Follows Firebase's documented procedure for verifying ID tokens with a
// third-party JWT library
// (https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library):
//   header:  alg = RS256, kid = one of Google's current securetoken keys
//   payload: exp in the future, iat and auth_time in the past,
//            aud = <project id>, iss = https://securetoken.google.com/<project id>,
//            sub = non-empty string (the user's UID)
//   signature: valid for the public key matching kid
//
// `jose` is ESM and gets bundled straight into each function, so there is no
// CommonJS → ESM require() at runtime. (firebase-admin pulls in jwks-rsa,
// which require()s the ESM-only jose@6 and crashes under `netlify dev`.)

import { decodeJwt, decodeProtectedHeader, errors as joseErrors, importX509, jwtVerify, type JWTPayload } from 'jose';

export interface VerifiedToken {
  uid: string;
  email?: string;
  email_verified?: boolean;
  auth_time: number;
  iat: number;
  exp: number;
}

/** Codes match the ones firebase-admin used, so callers handle them the same way. */
export type TokenErrorCode = 'auth/id-token-expired' | 'auth/argument-error' | 'auth/id-token-revoked' | 'auth/user-disabled';

export class TokenError extends Error {
  constructor(
    public code: TokenErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Resolves a key id to Google's public key, or null if Google doesn't (currently) publish that kid. */
export type KeySource = (kid: string) => Promise<CryptoKey | null>;

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certCache: { expiresAt: number; fetchedAt: number; keys: Map<string, CryptoKey> } | null = null;
// An unknown kid triggers a refetch (Google rotates keys), but at most once a
// minute — so junk tokens can't make every request hit Google.
const UNKNOWN_KID_REFETCH_MS = 60_000;

function maxAgeMs(cacheControl: string | null): number {
  const m = /max-age=(\d+)/.exec(cacheControl || '');
  return m ? Number(m[1]) * 1000 : 60 * 60 * 1000;
}

/** Google's securetoken signing certs, cached for as long as Google's Cache-Control allows. */
export function googleKeySource(fetchImpl: typeof fetch = fetch): KeySource {
  return async (kid) => {
    const stale = !certCache || Date.now() >= certCache.expiresAt;
    const unknownKid = certCache && !certCache.keys.has(kid) && Date.now() - certCache.fetchedAt > UNKNOWN_KID_REFETCH_MS;
    if (stale || unknownKid) {
      const res = await fetchImpl(CERTS_URL);
      if (!res.ok) throw new Error(`Could not fetch Firebase signing certificates (${res.status})`);
      const pems = (await res.json()) as Record<string, string>;
      const keys = new Map<string, CryptoKey>();
      for (const [id, pem] of Object.entries(pems)) keys.set(id, await importX509(pem, 'RS256'));
      certCache = { expiresAt: Date.now() + maxAgeMs(res.headers.get('cache-control')), fetchedAt: Date.now(), keys };
    }
    return certCache!.keys.get(kid) ?? null;
  };
}

export function _resetCertCache(): void {
  certCache = null;
}

/**
 * The Auth emulator issues UNSIGNED tokens. Accept them only when
 * FIREBASE_AUTH_EMULATOR_HOST is set AND we're not running in a deployed
 * Netlify context — so a stray env var can never disable signature checks
 * in production.
 */
export function emulatorAllowed(env: Record<string, string | undefined> = process.env): boolean {
  if (!env.FIREBASE_AUTH_EMULATOR_HOST) return false;
  const ctx = env.CONTEXT;
  return !ctx || ctx === 'dev';
}

const SKEW_S = 5;

function checkClaims(p: JWTPayload & { auth_time?: unknown }, projectId: string, nowS: number): VerifiedToken {
  if (p.aud !== projectId) throw new TokenError('auth/argument-error', 'Token has the wrong audience.');
  if (p.iss !== `https://securetoken.google.com/${projectId}`) throw new TokenError('auth/argument-error', 'Token has the wrong issuer.');
  if (typeof p.sub !== 'string' || p.sub.length === 0 || p.sub.length > 128) {
    throw new TokenError('auth/argument-error', 'Token has no valid subject.');
  }
  if (typeof p.exp !== 'number' || p.exp <= nowS - SKEW_S) throw new TokenError('auth/id-token-expired', 'Token has expired.');
  if (typeof p.iat !== 'number' || p.iat > nowS + SKEW_S) throw new TokenError('auth/argument-error', 'Token was issued in the future.');
  if (typeof p.auth_time !== 'number' || p.auth_time > nowS + SKEW_S) {
    throw new TokenError('auth/argument-error', 'Token has an invalid auth_time.');
  }
  return {
    uid: p.sub,
    email: typeof p.email === 'string' ? p.email : undefined,
    email_verified: typeof p.email_verified === 'boolean' ? p.email_verified : undefined,
    auth_time: p.auth_time,
    iat: p.iat,
    exp: p.exp,
  };
}

export interface VerifyOptions {
  keySource?: KeySource;
  emulator?: boolean;
  now?: () => number; // ms
}

export async function verifyFirebaseIdToken(token: string, projectId: string, opts: VerifyOptions = {}): Promise<VerifiedToken> {
  const nowS = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  if (!token || token.split('.').length !== 3) throw new TokenError('auth/argument-error', 'Malformed token.');

  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new TokenError('auth/argument-error', 'Malformed token.');
  }

  if (opts.emulator) {
    // Emulator tokens: alg "none", no signature. Claims still checked.
    let payload: JWTPayload;
    try {
      payload = decodeJwt(token);
    } catch {
      throw new TokenError('auth/argument-error', 'Malformed token.');
    }
    return checkClaims(payload, projectId, nowS);
  }

  if (header.alg !== 'RS256') throw new TokenError('auth/argument-error', 'Token must be signed with RS256.');
  if (!header.kid) throw new TokenError('auth/argument-error', 'Token has no key id.');
  const keySource = opts.keySource ?? googleKeySource();
  const key = await keySource(header.kid);
  if (!key) throw new TokenError('auth/argument-error', 'Token was not signed by a current Firebase key.');

  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['RS256'],
      audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`,
      clockTolerance: SKEW_S,
      currentDate: new Date(nowS * 1000),
    });
    return checkClaims(payload, projectId, nowS);
  } catch (err) {
    if (err instanceof TokenError) throw err;
    if (err instanceof joseErrors.JWTExpired) throw new TokenError('auth/id-token-expired', 'Token has expired.');
    throw new TokenError('auth/argument-error', 'Token signature or claims are invalid.');
  }
}
