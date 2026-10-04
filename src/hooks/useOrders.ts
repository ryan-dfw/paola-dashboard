import { useCallback, useEffect, useRef, useState } from 'react';
import type { FulfillmentRequest, Order } from '../../shared/types';
import { api, ApiError } from '../lib/api';

export interface OrdersState {
  status: 'loading' | 'ready' | 'error';
  orders: Order[];
  /** True while further pages are still arriving. */
  loadingMore: boolean;
  error: ApiError | null;
  /** Some pages loaded, then a later page failed. */
  partial: boolean;
  loadedAt: number | null;
}

const PAGE = 50;

export function useOrders() {
  const [state, setState] = useState<OrdersState>({
    status: 'loading',
    orders: [],
    loadingMore: false,
    error: null,
    partial: false,
    loadedAt: null,
  });
  const run = useRef(0);

  const load = useCallback(async () => {
    const id = ++run.current;
    setState((s) => ({ ...s, status: s.orders.length ? s.status : 'loading', error: null, loadingMore: true }));
    const all: Order[] = [];
    let cursor: string | null = null;
    let first = true;
    try {
      // Follow Stripe's cursors until there are no more pages.
      do {
        const page = await api.orders(cursor, PAGE);
        if (id !== run.current) return;
        all.push(...page.orders);
        cursor = page.nextCursor;
        if (first || !cursor) {
          setState({ status: 'ready', orders: [...all], loadingMore: Boolean(cursor), error: null, partial: false, loadedAt: Date.now() });
          first = false;
        }
      } while (cursor);
      setState({ status: 'ready', orders: all, loadingMore: false, error: null, partial: false, loadedAt: Date.now() });
    } catch (err) {
      if (id !== run.current) return;
      const e = err instanceof ApiError ? err : new ApiError(0, 'unknown', (err as Error).message);
      setState((s) =>
        all.length
          ? { status: 'ready', orders: all, loadingMore: false, error: e, partial: true, loadedAt: Date.now() }
          : { ...s, status: s.orders.length ? 'ready' : 'error', loadingMore: false, error: e, partial: s.orders.length > 0 },
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh when the app comes back to the foreground (e.g. reopening on the phone).
  useEffect(() => {
    const on = () => {
      if (document.visibilityState === 'visible' && state.loadedAt && Date.now() - state.loadedAt > 60_000) void load();
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [load, state.loadedAt]);

  const replace = useCallback((o: Order) => {
    setState((s) => ({
      ...s,
      orders: s.orders.some((x) => x.id === o.id) ? s.orders.map((x) => (x.id === o.id ? o : x)) : [o, ...s.orders],
    }));
  }, []);

  const act = useCallback(
    async (id: string, req: FulfillmentRequest): Promise<Order> => {
      try {
        const o = await api.fulfill(id, req);
        replace(o);
        return o;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // Someone/something changed it — show the fresh version.
          try {
            replace(await api.order(id));
          } catch {
            /* keep the original error */
          }
        }
        throw err;
      }
    },
    [replace],
  );

  const refreshOne = useCallback(
    async (id: string) => {
      const o = await api.order(id);
      replace(o);
      return o;
    },
    [replace],
  );

  return { ...state, reload: load, act, refreshOne };
}
