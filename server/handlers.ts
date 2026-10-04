// Request handlers, written against web-standard Request/Response with their
// dependencies injectable, so tests can drive them with a fake Stripe and a
// fake token verifier. The files in netlify/functions/ are thin wrappers.

import type Stripe from 'stripe';
import type { FulfillmentRequest, Me } from '../shared/types';
import { accountAction, adminStatus, type AccountAction } from './admin';
import { defaultVerifier, requireUser, type TokenVerifier } from './auth';
import { readConfig, type ServerConfig } from './env';
import { errorResponse, HttpError, json, readJson, requireMethod } from './http';
import { applyFulfillment, getOrder, listOrders, stripeFor } from './orders';

export interface Deps {
  config: ServerConfig;
  verify: TokenVerifier;
  stripe: () => Stripe;
}

export function defaultDeps(): Deps {
  const config = readConfig();
  return { config, verify: defaultVerifier(config), stripe: () => stripeFor(config) };
}

type Handler = (req: Request, deps: Deps, params: Record<string, string>) => Promise<Response>;

/** Wraps a handler so every thrown error becomes a clean JSON response. */
export function route(h: Handler) {
  return async (req: Request, deps: Deps = defaultDeps(), params: Record<string, string> = {}) => {
    try {
      return await h(req, deps, params);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export const meHandler = route(async (req, deps) => {
  requireMethod(req, 'GET');
  const user = await requireUser(req, deps.config, deps.verify);
  const me: Me = { uid: user.uid, email: user.email, role: user.role };
  return json(me);
});

export const ordersHandler = route(async (req, deps) => {
  requireMethod(req, 'GET');
  await requireUser(req, deps.config, deps.verify); // before ANY Stripe access
  const url = new URL(req.url);
  const cursor = url.searchParams.get('cursor');
  if (cursor && !/^cs_(test|live)_[A-Za-z0-9]+$/.test(cursor)) throw new HttpError(400, 'bad_cursor', 'Bad page cursor.');
  const limitRaw = Number(url.searchParams.get('limit') || 50);
  const page = await listOrders(deps.stripe(), { cursor, limit: Number.isFinite(limitRaw) ? limitRaw : 50 });
  return json(page);
});

export const orderHandler = route(async (req, deps, params) => {
  requireMethod(req, 'GET');
  await requireUser(req, deps.config, deps.verify);
  return json(await getOrder(deps.stripe(), params.sessionId || ''));
});

export const fulfillmentHandler = route(async (req, deps, params) => {
  requireMethod(req, 'POST', 'PATCH');
  const user = await requireUser(req, deps.config, deps.verify);
  const body = await readJson<FulfillmentRequest>(req);
  if (!body || typeof body !== 'object' || typeof (body as { action?: unknown }).action !== 'string') {
    throw new HttpError(400, 'bad_input', 'Missing action.');
  }
  const order = await applyFulfillment(deps.stripe(), params.sessionId || '', body, user);
  return json(order);
});

export const adminStatusHandler = route(async (req, deps) => {
  requireMethod(req, 'GET');
  await requireUser(req, deps.config, deps.verify, 'superadmin');
  let stripe: Stripe | null = null;
  try {
    stripe = deps.stripe();
  } catch {
    stripe = null;
  }
  return json(await adminStatus(deps.config, stripe));
});

export const adminAccountsHandler = route(async (req, deps) => {
  requireMethod(req, 'POST');
  await requireUser(req, deps.config, deps.verify, 'superadmin');
  const body = await readJson<AccountAction>(req);
  return json(await accountAction(deps.config, body));
});
