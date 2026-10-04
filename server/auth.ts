// Every protected function calls requireUser() before touching Stripe.
// Hiding screens in React is NOT the security boundary — this is.

import type { Role } from '../shared/types';
import type { Principal, ServerConfig } from './env';
import { firebaseAdmin, FirebaseAdminError, type FirebaseUser } from './firebaseAdmin';
import { emulatorAllowed, TokenError, verifyFirebaseIdToken, type KeySource, type VerifiedToken } from './firebaseToken';
import { HttpError } from './http';

type DecodedIdToken = VerifiedToken;

export interface AuthedUser {
  uid: string;
  email: string | null;
  role: Role;
}

export type TokenVerifier = (token: string) => Promise<DecodedIdToken>;

// Short cache so a revocation/disable check doesn't cost a round-trip on every request.
const userCache = new Map<string, { at: number; user: FirebaseUser }>();
const USER_TTL_MS = 60_000;

export function defaultVerifier(config: ServerConfig, deps: { keySource?: KeySource; fetchImpl?: typeof fetch } = {}): TokenVerifier {
  return async (token) => {
    if (!config.firebaseProjectId) {
      throw new HttpError(500, 'config_missing', 'FIREBASE_PROJECT_ID is not set on the server.');
    }
    const decoded = await verifyFirebaseIdToken(token, config.firebaseProjectId, { emulator: emulatorAllowed(), keySource: deps.keySource });

    // With Admin credentials (or the emulator) also honour disabled accounts
    // and revoked sessions, like firebase-admin's verifyIdToken(token, true).
    const admin = firebaseAdmin(config, deps.fetchImpl);
    if (admin) {
      let user = userCache.get(decoded.uid);
      if (!user || Date.now() - user.at > USER_TTL_MS) {
        try {
          user = { at: Date.now(), user: await admin.getUser(decoded.uid) };
          userCache.set(decoded.uid, user);
        } catch (err) {
          if (err instanceof FirebaseAdminError && err.code === 'user-not-found') {
            throw new TokenError('auth/id-token-revoked', 'This account no longer exists.');
          }
          // This check is an extra on top of the signature check above. If the
          // optional Admin credentials are broken (or Google is unreachable),
          // don't lock everyone out — log it; Setup shows the credential error.
          console.error('Skipping revoked/disabled check:', (err as Error).message);
          user = undefined;
        }
      }
      if (!user) return decoded;
      if (user.user.disabled) throw new TokenError('auth/user-disabled', 'This account is disabled.');
      if (user.user.validSince && decoded.auth_time < user.user.validSince) {
        throw new TokenError('auth/id-token-revoked', 'This sign-in was revoked.');
      }
    }
    return decoded;
  };
}

export function bearerToken(req: Request): string {
  const header = req.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw new HttpError(401, 'missing_token', 'Sign in required.');
  return match[1];
}

/**
 * Match a verified token against the allowlist, by UID or (case-insensitive)
 * email. Email verification is not required: with self sign-up turned off in
 * Firebase, only accounts created by an admin exist in the first place.
 */
export function roleFor(decoded: Pick<DecodedIdToken, 'uid' | 'email'>, principals: Principal[]): Role | null {
  const email = decoded.email?.toLowerCase();
  const matches = principals.filter((p) => (p.kind === 'uid' ? p.value === decoded.uid : Boolean(email) && p.value === email));
  if (matches.some((p) => p.role === 'superadmin')) return 'superadmin';
  if (matches.length) return 'user';
  return null;
}

export async function requireUser(
  req: Request,
  config: ServerConfig,
  verify: TokenVerifier = defaultVerifier(config),
  required: Role = 'user',
): Promise<AuthedUser> {
  const token = bearerToken(req);

  let decoded: DecodedIdToken;
  try {
    decoded = await verify(token);
  } catch (err) {
    const code = (err as { code?: string })?.code || '';
    if (code === 'auth/id-token-expired') {
      throw new HttpError(401, 'token_expired', 'Your sign-in expired. Please sign in again.');
    }
    if (code === 'auth/id-token-revoked' || code === 'auth/user-disabled') {
      throw new HttpError(401, 'token_revoked', 'This sign-in is no longer valid. Please sign in again.');
    }
    if (err instanceof HttpError) throw err;
    if (err instanceof TokenError || code.startsWith('auth/')) {
      throw new HttpError(401, 'invalid_token', 'Sign in required.');
    }
    // Couldn't reach Google (signing certs / account lookup). Fail closed, but
    // don't call it a bad sign-in — that would bounce the user to the login screen.
    console.error('Token verification unavailable:', err);
    throw new HttpError(503, 'auth_unavailable', 'Couldn’t check your sign-in right now. Try again in a minute.');
  }

  const role = roleFor(decoded, config.principals);
  if (!role) {
    throw new HttpError(403, 'not_authorized', 'This account does not have access to the dashboard.');
  }
  if (required === 'superadmin' && role !== 'superadmin') {
    throw new HttpError(403, 'superadmin_only', 'Only the site administrator can do that.');
  }
  return { uid: decoded.uid, email: decoded.email ?? null, role };
}
