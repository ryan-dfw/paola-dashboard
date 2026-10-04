import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth';
import type { Me } from '../../shared/types';
import { api, ApiError, setAuthExpiredHandler } from '../lib/api';
import { getFirebaseAuth } from '../lib/firebase';

export type AuthState =
  | { kind: 'loading' }
  | { kind: 'signed_out'; notice: string | null }
  | { kind: 'checking'; user: User }
  | { kind: 'denied'; user: User; code: string; message: string }
  | { kind: 'error'; user: User; message: string }
  | { kind: 'ready'; user: User; me: Me };

interface AuthApi {
  state: AuthState;
  signIn(email: string, password: string): Promise<void>;
  signOut(notice?: string): Promise<void>;
  resetPassword(email: string): Promise<void>;
  recheck(): void;
}

const Ctx = createContext<AuthApi | null>(null);

export function friendlyAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code || '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-email':
      return 'That email and password don’t match. Check them and try again.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes, or reset your password.';
    case 'auth/network-request-failed':
      return "Can't reach the sign-in service. Check your connection.";
    case 'auth/user-disabled':
      return 'This account has been disabled.';
    default:
      return 'Sign-in failed. Please try again.';
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);
  const auth = getFirebaseAuth();

  const signOut = useCallback(
    async (notice?: string) => {
      await fbSignOut(auth);
      setState({ kind: 'signed_out', notice: notice ?? null });
    },
    [auth],
  );

  useEffect(() => {
    setAuthExpiredHandler(() => {
      void signOut('Your sign-in expired. Please sign in again.');
    });
    return () => setAuthExpiredHandler(null);
  }, [signOut]);

  useEffect(() => {
    let cancelled = false;
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setState((s) => (s.kind === 'signed_out' ? s : { kind: 'signed_out', notice: null }));
        return;
      }
      setState({ kind: 'checking', user });
      try {
        const me = await api.me();
        if (!cancelled) setState({ kind: 'ready', user, me });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          setState({ kind: 'denied', user, code: err.code, message: err.message });
        } else if (err instanceof ApiError && err.status === 401) {
          // handled by the expired handler
        } else {
          setState({ kind: 'error', user, message: (err as Error).message });
        }
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [auth, nonce]);

  const value = useMemo<AuthApi>(
    () => ({
      state,
      async signIn(email, password) {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      },
      signOut,
      async resetPassword(email) {
        await sendPasswordResetEmail(auth, email.trim());
      },
      recheck() {
        void auth.currentUser?.reload().finally(() => setNonce((n) => n + 1));
      },
    }),
    [auth, state, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
