import type { Config, Context } from '@netlify/functions';
import { meHandler } from '../../server/handlers';

// GET /api/me — who am I, and am I allowed in? (role: user | superadmin)
export default (req: Request, _ctx: Context) => meHandler(req);
export const config: Config = { path: '/api/me' };
