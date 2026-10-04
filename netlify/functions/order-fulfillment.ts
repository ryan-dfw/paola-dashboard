import type { Config, Context } from '@netlify/functions';
import { fulfillmentHandler } from '../../server/handlers';

// POST /api/orders/:sessionId/fulfillment — mark picked up / shipped / undo, stored in Stripe metadata.
export default (req: Request, ctx: Context) => fulfillmentHandler(req, undefined, ctx.params);
export const config: Config = { path: '/api/orders/:sessionId/fulfillment', method: ['POST', 'PATCH'] };
