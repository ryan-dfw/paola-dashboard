import type { Config, Context } from '@netlify/functions';
import { ordersHandler } from '../../server/handlers';

// GET /api/orders?cursor=<session id>&limit=<1-100> — one page of normalized orders, newest first.
export default (req: Request, _ctx: Context) => ordersHandler(req);
export const config: Config = { path: '/api/orders' };
