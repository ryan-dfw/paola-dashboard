import { Brand } from '../components/Brand';
import { useAuth } from '../hooks/useAuth';

export function AccessProblem({ email, message, retryable }: { email: string | null; message: string; retryable?: boolean }) {
  const { signOut, recheck } = useAuth();

  return (
    <main className="login">
      <Brand />
      <div className="login-card">
        <h1>{retryable ? 'Can’t load' : 'No access'}</h1>
        <p className="login-error" role="alert">
          {message}
        </p>
        {email && <p className="muted">Signed in as {email}</p>}

        {retryable && (
          <button className="btn btn-primary btn-block" onClick={recheck}>
            Try again
          </button>
        )}

        <button className="btn btn-quiet btn-block" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </main>
  );
}
