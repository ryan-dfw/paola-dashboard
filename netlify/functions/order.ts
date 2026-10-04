import type { Config, Context } from '@netlify/functions';
import { orderHandler } from '../../server/handlers';

// GET /api/orders/:sessionId — one normalized order.
export default (req: Request, ctx: Context) => orderHandler(req, undefined, ctx.params);
export const config: Config = { path: '/api/orders/:sessionId' };
