import { Hono } from 'hono';
import { expireClaims } from './ledger';
import { ApiError, type AppEnv } from './lib';
import { adminRoutes } from './routes/admin';
import { agentRoutes } from './routes/agent';
import { masterRoutes } from './routes/master';
import { publicRoutes } from './routes/public';

const app = new Hono<AppEnv>();

app.route('/', publicRoutes);
app.route('/', agentRoutes);
app.route('/v1/master', masterRoutes);
app.route('/v1/admin', adminRoutes);

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint. Read /agents.md.' } }, 404));

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
  console.error(err);
  return c.json({ error: { code: 'internal', message: 'Internal error.' } }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env) {
    const expired = await expireClaims(env.DB);
    if (expired > 0) console.log(`expired ${expired} claims`);
  },
} satisfies ExportedHandler<Env>;
