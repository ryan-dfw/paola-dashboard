import type { ApiErrorBody } from '../shared/types';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const NO_STORE = {
  'Content-Type': 'application/json; charset=utf-8',
  // Order data is personal — never let a browser or CDN cache it.
  'Cache-Control': 'no-store, private',
  'X-Robots-Tag': 'noindex, nofollow',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: NO_STORE });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    const body: ApiErrorBody = { error: err.message, code: err.code };
    return json(body, err.status);
  }
  // Stripe SDK errors carry a type. "Stripe is down" is told apart from
  // "Stripe refused" (bad key / missing permission on a restricted key), so
  // the UI can say the right thing. Any (masked) key Stripe echoes back is redacted.
  const anyErr = err as { type?: string; message?: string };
  const msg = (anyErr?.message || '').replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9*]+/g, '[key]');
  if (anyErr?.type && String(anyErr.type).startsWith('Stripe')) {
    console.error('Stripe error:', anyErr.type, anyErr.message);
    const map: Record<string, [string, string]> = {
      StripeAuthenticationError: ['stripe_auth', 'Stripe rejected the API key. Check STRIPE_SECRET_KEY.'],
      StripePermissionError: ['stripe_permission', `The Stripe key is missing a permission: ${msg}`],
      StripeInvalidRequestError: ['stripe_rejected', `Stripe rejected the request: ${msg}`],
    };
    const [code, error] = map[anyErr.type] ?? ['stripe_unavailable', 'Could not reach Stripe right now. Try again in a minute.'];
    const body: ApiErrorBody = { error, code };
    return json(body, 502);
  }
  console.error('Unexpected error:', err);
  const body: ApiErrorBody = { error: 'Something went wrong on the server.', code: 'internal' };
  return json(body, 500);
}

export function requireMethod(req: Request, ...methods: string[]): void {
  if (!methods.includes(req.method)) {
    throw new HttpError(405, 'method_not_allowed', `Use ${methods.join(' or ')}.`);
  }
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body must be JSON.');
  }
}
