// A small in-memory stand-in for the parts of the Stripe SDK the server uses.
// Behaves like Stripe where it matters: newest-first lists, cursor
// pagination via starting_after, key-by-key metadata merges ('' unsets).

import type Stripe from 'stripe';
import { PRODUCTS } from './stripe';

function asyncIter<T>(items: T[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const i of items) yield i;
    },
  };
}

function merge(target: Record<string, string>, patch: Record<string, string>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === '') delete target[k];
    else target[k] = v;
  }
}

export interface FakeStripeOptions {
  refuseSessionUpdate?: boolean;
}

export function fakeStripe(initial: Stripe.Checkout.Session[], opts: FakeStripeOptions = {}) {
  const sessions = new Map(initial.map((s) => [s.id, structuredClone(s)]));
  const calls: { method: string; args: unknown[] }[] = [];

  const sorted = () => [...sessions.values()].sort((a, b) => b.created - a.created);
  const pi = (s: Stripe.Checkout.Session) => s.payment_intent as Stripe.PaymentIntent;

  const stripe = {
    checkout: {
      sessions: {
        async list(params: { limit?: number; starting_after?: string; status?: string; expand?: string[] }) {
          calls.push({ method: 'sessions.list', args: [params] });
          let all = sorted();
          if (params.status) all = all.filter((s) => s.status === params.status);
          let start = 0;
          if (params.starting_after) {
            start = all.findIndex((s) => s.id === params.starting_after) + 1;
            if (start === 0)
              throw Object.assign(new Error('No such checkout.session'), { type: 'StripeInvalidRequestError', statusCode: 400 });
          }
          const limit = params.limit ?? 10;
          const data = all.slice(start, start + limit).map((s) => structuredClone(s));
          return { object: 'list', data, has_more: start + limit < all.length, url: '/v1/checkout/sessions' };
        },
        async retrieve(id: string) {
          calls.push({ method: 'sessions.retrieve', args: [id] });
          const s = sessions.get(id);
          if (!s) throw Object.assign(new Error('No such checkout.session'), { type: 'StripeInvalidRequestError', statusCode: 404 });
          return structuredClone(s);
        },
        async update(id: string, params: { metadata: Record<string, string> }) {
          calls.push({ method: 'sessions.update', args: [id, params] });
          if (opts.refuseSessionUpdate) {
            throw Object.assign(new Error('This Checkout Session can no longer be updated'), {
              type: 'StripeInvalidRequestError',
              statusCode: 400,
            });
          }
          const s = sessions.get(id)!;
          s.metadata = s.metadata || {};
          merge(s.metadata, params.metadata);
          return structuredClone(s);
        },
        listLineItems(id: string) {
          return asyncIter(sessions.get(id)?.line_items?.data ?? []);
        },
      },
    },
    paymentIntents: {
      async update(id: string, params: { metadata: Record<string, string> }) {
        calls.push({ method: 'paymentIntents.update', args: [id, params] });
        for (const s of sessions.values()) {
          const p = pi(s);
          if (p?.id === id) {
            p.metadata = p.metadata || {};
            merge(p.metadata as Record<string, string>, params.metadata);
            return structuredClone(p);
          }
        }
        throw Object.assign(new Error('No such payment_intent'), { type: 'StripeInvalidRequestError', statusCode: 404 });
      },
    },
    products: {
      list() {
        calls.push({ method: 'products.list', args: [] });
        return asyncIter(Object.values(PRODUCTS));
      },
    },
  };

  return { stripe: stripe as unknown as Stripe, calls, sessions };
}
