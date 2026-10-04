import type { AdminStatus, FulfillmentRequest, Me, Order, OrdersPage } from '../../shared/types';
import { getFirebaseAuth } from './firebase';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
  get isAuth() {
    return this.status === 401;
  }
}

let onAuthExpired: ((err: ApiError) => void) | null = null;
export function setAuthExpiredHandler(fn: ((err: ApiError) => void) | null) {
  onAuthExpired = fn;
}

async function call<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new ApiError(401, 'signed_out', 'Please sign in.');
  const token = await user.getIdToken(retried);

  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
  } catch {
    throw new ApiError(0, 'network', "Can't reach the server. Check your connection and try again.");
  }

  if (res.status === 401 && !retried) {
    // The token may simply be stale — force-refresh once before giving up.
    return call<T>(path, init, true);
  }

  const body = (await res.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
  if (!res.ok) {
    const err = new ApiError(
      res.status,
      body?.code || `http_${res.status}`,
      body?.error || (res.status >= 500 ? 'The server had a problem. Try again in a minute.' : 'Request failed.'),
    );
    if (res.status === 401) onAuthExpired?.(err);
    throw err;
  }
  return body as T;
}

export const api = {
  me: () => call<Me>('/api/me'),
  orders: (cursor: string | null, limit = 50) =>
    call<OrdersPage>(`/api/orders?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  order: (id: string) => call<Order>(`/api/orders/${encodeURIComponent(id)}`),
  fulfill: (id: string, body: FulfillmentRequest) =>
    call<Order>(`/api/orders/${encodeURIComponent(id)}/fulfillment`, { method: 'POST', body: JSON.stringify(body) }),
  adminStatus: () => call<AdminStatus>('/api/admin/status'),
  adminAccount: (body: { action: 'create'; email: string }) =>
    call<{ ok: true; message: string }>('/api/admin/accounts', { method: 'POST', body: JSON.stringify(body) }),
};
