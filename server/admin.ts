// Superadmin-only helpers: a setup health check and account tools for
// allowlisted people. Nothing here can grant access to anyone who isn't
// already in DASHBOARD_USERS / DASHBOARD_SUPERADMINS.

import type Stripe from 'stripe';
import type { AdminStatus, AllowlistEntry } from '../shared/types';
import type { ServerConfig } from './env';
import { firebaseAdmin, FirebaseAdminError } from './firebaseAdmin';
import { HttpError } from './http';

const ENV_NAMES: { name: string; required: boolean; note?: string }[] = [
  { name: 'STRIPE_SECRET_KEY', required: true },
  { name: 'FIREBASE_PROJECT_ID', required: false, note: 'falls back to VITE_FIREBASE_PROJECT_ID' },
  { name: 'FIREBASE_CLIENT_EMAIL', required: false, note: 'only needed for the account tools below' },
  { name: 'FIREBASE_PRIVATE_KEY', required: false, note: 'only needed for the account tools below' },
  { name: 'DASHBOARD_USERS', required: false },
  { name: 'DASHBOARD_SUPERADMINS', required: true },
  { name: 'VITE_FIREBASE_API_KEY', required: true, note: 'client-safe; baked into the build' },
  { name: 'VITE_FIREBASE_AUTH_DOMAIN', required: true, note: 'client-safe' },
  { name: 'VITE_FIREBASE_PROJECT_ID', required: true, note: 'client-safe' },
  { name: 'VITE_FIREBASE_APP_ID', required: false, note: 'client-safe' },
];

export function keyInfo(key: string | null): { mode: 'live' | 'test' | 'unknown'; keyType: 'secret' | 'restricted' | 'unknown' } {
  if (!key) return { mode: 'unknown', keyType: 'unknown' };
  const m = /^(sk|rk)_(live|test)_/.exec(key);
  if (!m) return { mode: 'unknown', keyType: 'unknown' };
  return { mode: m[2] as 'live' | 'test', keyType: m[1] === 'rk' ? 'restricted' : 'secret' };
}

export async function adminStatus(config: ServerConfig, stripe: Stripe | null, env = process.env): Promise<AdminStatus> {
  const envReport = ENV_NAMES.map(({ name, note }) => ({
    name,
    present: Boolean(env[name]?.trim()),
    ...(note ? { note } : {}),
  }));

  const ki = keyInfo(config.stripeSecretKey);
  let stripeReport: AdminStatus['stripe'] = { ok: false, ...ki, detail: 'STRIPE_SECRET_KEY is not set.' };
  if (stripe) {
    try {
      // Cheapest call that proves the key works AND can read Checkout Sessions.
      const probe = await stripe.checkout.sessions.list({ limit: 1, status: 'complete' });
      stripeReport = {
        ok: true,
        ...ki,
        detail: probe.data.length ? 'Connected — can read orders.' : 'Connected — no completed checkouts yet.',
      };
    } catch (err) {
      stripeReport = { ok: false, ...ki, detail: `Stripe refused: ${(err as Error).message}` };
    }
  }

  const allowlist: AllowlistEntry[] = [];
  const auth = firebaseAdmin(config);
  for (const p of config.principals) {
    if (!auth) {
      allowlist.push({
        value: p.value,
        kind: p.kind,
        role: p.role,
        account: { checked: false, reason: 'Firebase Admin credentials not set' },
      });
      continue;
    }
    try {
      const u = p.kind === 'email' ? await auth.getUserByEmail(p.value) : await auth.getUser(p.value);
      allowlist.push({
        value: p.value,
        kind: p.kind,
        role: p.role,
        account: {
          checked: true,
          exists: true,
          uid: u.uid,
          email: u.email,
          disabled: u.disabled,
          lastSignIn: u.lastSignIn,
        },
      });
    } catch (err) {
      if (err instanceof FirebaseAdminError && err.code === 'user-not-found') {
        allowlist.push({ value: p.value, kind: p.kind, role: p.role, account: { checked: true, exists: false } });
      } else {
        allowlist.push({ value: p.value, kind: p.kind, role: p.role, account: { checked: false, reason: (err as Error).message } });
      }
    }
  }

  return {
    env: envReport,
    stripe: stripeReport,
    firebase: { projectId: config.firebaseProjectId, adminCredentials: Boolean(config.serviceAccount) },
    allowlist,
  };
}

export type AccountAction = { action: 'create'; email: string };

/**
 * Create a Firebase account with NO password; the browser then sends the
 * person a password-setup (reset) email, so only whoever controls that inbox
 * can ever sign in. Only for emails already on the allowlist.
 */
export async function accountAction(config: ServerConfig, body: AccountAction): Promise<{ ok: true; message: string }> {
  const auth = firebaseAdmin(config);
  if (!auth) {
    throw new HttpError(400, 'no_admin_credentials', 'Set FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY to use account tools.');
  }
  const email = (body.email || '').trim().toLowerCase();
  const listed = config.principals.some((p) => p.kind === 'email' && p.value === email);
  if (!listed) throw new HttpError(403, 'not_allowlisted', 'Add this email to DASHBOARD_USERS first.');
  if (body.action !== 'create') throw new HttpError(400, 'bad_action', 'Unknown action.');

  try {
    await auth.createUser({ email, emailVerified: true });
  } catch (err) {
    if (err instanceof FirebaseAdminError && err.code === 'email-exists') {
      throw new HttpError(409, 'exists', 'An account with that email already exists.');
    }
    throw err;
  }
  return { ok: true, message: 'Account created.' };
}
