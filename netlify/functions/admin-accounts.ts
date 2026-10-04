import type { Config, Context } from '@netlify/functions';
import { adminAccountsHandler } from '../../server/handlers';

// POST /api/admin/accounts — superadmin: create a Firebase account for an allowlisted email.
export default (req: Request, _ctx: Context) => adminAccountsHandler(req);
export const config: Config = { path: '/api/admin/accounts' };
