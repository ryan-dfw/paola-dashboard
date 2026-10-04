import { Brand } from './components/Brand';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { useHashRoute } from './hooks/useHashRoute';
import { firebaseConfigMissing } from './lib/firebase';
import { AccessProblem } from './screens/AccessProblem';
import { Dashboard } from './screens/Dashboard';
import { Login } from './screens/Login';

function Gate() {
  const { state } = useAuth();
  const { route, go, back } = useHashRoute();

  switch (state.kind) {
    case 'loading':
    case 'checking':
      return (
        <main className="login" aria-busy="true">
          <Brand />
          <p className="muted">Loading…</p>
        </main>
      );
    case 'signed_out':
      return <Login notice={state.notice} />;
    case 'denied':
      return <AccessProblem email={state.user.email} message={state.message} />;
    case 'error':
      return <AccessProblem email={state.user.email} message={state.message} retryable />;
    case 'ready':
      return <Dashboard me={state.me} route={route} go={go} back={back} />;
  }
}

export function App() {
  if (firebaseConfigMissing.length) {
    return (
      <main className="login">
        <Brand />
        <div className="login-card">
          <h1>Not configured</h1>
          <p>The sign-in settings are missing from this build: {firebaseConfigMissing.join(', ')}.</p>
        </div>
      </main>
    );
  }
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
