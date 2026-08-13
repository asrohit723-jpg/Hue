import { useEffect, useState } from 'react';
import { getCurrentUser, login, type CurrentUser } from './lib/vibe';
import { Shell } from './screens/Shell';
import { SignIn } from './screens/SignIn';
import { BootSkeleton } from './screens/BootSkeleton';

type AuthState =
  | { phase: 'checking' }
  | { phase: 'signedOut' }
  | { phase: 'signedIn'; me: CurrentUser }
  | { phase: 'error'; message: string };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ phase: 'checking' });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const me = await getCurrentUser();
        if (cancelled) return;
        // getCurrentUser() returning null is the SDK's way of reporting a 401.
        // It is the only signal that drives the login screen — a 401 from any
        // other call is surfaced as an error, not a redirect.
        setAuth(me ? { phase: 'signedIn', me } : { phase: 'signedOut' });
      } catch (err) {
        if (cancelled) return;
        setAuth({
          phase: 'error',
          message: err instanceof Error ? err.message : 'Could not reach the server.',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  switch (auth.phase) {
    case 'checking':
      return <BootSkeleton />;
    case 'signedOut':
      return <SignIn onSignIn={login} />;
    case 'error':
      return <SignIn onSignIn={login} error={auth.message} />;
    case 'signedIn':
      return <Shell me={auth.me} />;
  }
}
