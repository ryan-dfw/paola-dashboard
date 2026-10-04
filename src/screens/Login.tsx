import { useState, type FormEvent } from 'react';
import { friendlyAuthError, useAuth } from '../hooks/useAuth';
import { Brand } from '../components/Brand';

export function Login({ notice }: { notice: string | null }) {
  const { signIn, resetPassword } = useAuth();
  const [mode, setMode] = useState<'signin' | 'reset'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(notice);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === 'signin') {
        await signIn(email, password);
      } else {
        await resetPassword(email);
        setInfo('If there’s an account for that email, a password reset link is on its way. Check your inbox (and spam).');
        setMode('signin');
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (mode === 'reset' && (code === 'auth/user-not-found' || code === 'auth/invalid-email')) {
        // Don't reveal whether an account exists.
        setInfo('If there’s an account for that email, a password reset link is on its way. Check your inbox (and spam).');
        setMode('signin');
      } else {
        setError(friendlyAuthError(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <Brand />
      <form className="login-card" onSubmit={submit} noValidate>
        <h1>{mode === 'signin' ? 'Orders' : 'Reset password'}</h1>
        {info && (
          <p className="login-info" role="status">
            {info}
          </p>
        )}
        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        {mode === 'signin' && (
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        <button type="submit" className="btn btn-primary btn-big btn-block" disabled={busy || !email || (mode === 'signin' && !password)}>
          {busy ? 'One moment…' : mode === 'signin' ? 'Sign in' : 'Send reset link'}
        </button>
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            setMode(mode === 'signin' ? 'reset' : 'signin');
            setError(null);
          }}
        >
          {mode === 'signin' ? 'Forgot password?' : 'Back to sign in'}
        </button>
      </form>
    </main>
  );
}
