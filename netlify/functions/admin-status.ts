import type { Config, Context } from '@netlify/functions';
import { adminStatusHandler } from '../../server/handlers';

// GET /api/admin/status — superadmin setup health check.
export default (req: Request, _ctx: Context) => adminStatusHandler(req);
export const config: Config = { path: '/api/admin/status' };
