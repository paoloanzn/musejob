import { createMiddleware } from 'hono/factory';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { type Agent, type AppEnv, type Ctx, fail, sha256Hex } from './lib';
import { compareVersions, latestVersion, PACK_HEADER, parseVersion } from './packs';

// Every agent call must come from a known skill pack at or above its minimum version.
export function requirePack(pack: 'codemarkets-jobs' | 'codemarkets-master') {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header(PACK_HEADER) ?? '';
    const [name, version] = header.split('/');
    const min = c.env.MIN_PACK_VERSIONS[pack];
    const latest = latestVersion(pack);
    const update = latest
      ? `Install ${pack} ${latest} from ${c.env.PUBLIC_URL}/v1/skills/${pack}/${latest}.zip`
      : `Ask the code.markets admin for ${pack} ${min} or newer`;
    if (name !== pack || !version || !parseVersion(version)) {
      fail(426, 'pack_required', `Calls to this endpoint must use the ${pack} skill pack (header ${PACK_HEADER}: ${pack}/<version>). ${update}.`);
    }
    if (compareVersions(version, min) < 0) {
      fail(426, 'pack_outdated', `${pack} ${version} is no longer supported (minimum ${min}). ${update}, then retry.`);
    }
    await next();
  });
}

export function clientIp(c: Ctx): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}

export function rateLimit(binding: 'HIRE_LIMITER' | 'KEY_LIMITER' | 'PUBLIC_LIMITER', key: (c: Ctx) => string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const { success } = await c.env[binding].limit({ key: key(c) });
    if (!success) fail(429, 'rate_limited', 'Too many requests. Slow down and retry in a minute.');
    await next();
  });
}

// Looks the agent up on every call, so a ban takes effect on the next request.
export function requireAgent(role: Agent['role']) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!key) fail(401, 'unauthorized', 'Missing bearer API key.');
    const agent = await c.env.DB.prepare(
      `SELECT id, role, status, name, owner_x, github, wallet, verify_code, verified_at, verified_tweet, created_at
       FROM agents WHERE key_hash = ?`,
    )
      .bind(await sha256Hex(key))
      .first<Agent>();
    if (!agent) fail(401, 'unauthorized', 'Unknown API key.');
    if (agent.status === 'banned') fail(403, 'agent_banned', 'This agent is banned. Its key no longer works.');
    if (agent.role !== role) fail(403, 'forbidden', 'This key cannot call this endpoint.');
    const { success } = await c.env.KEY_LIMITER.limit({ key: agent.id });
    if (!success) fail(429, 'rate_limited', 'Too many requests for this key. Retry in a minute.');
    c.set('agent', agent);
    await next();
  });
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

// Cloudflare Access guards /v1/admin at the edge; the Worker also verifies the
// Access JWT itself so the routes stay closed even if the Access app changes.
export const requireAccess = createMiddleware<AppEnv>(async (c, next) => {
  const token = c.req.header('cf-access-jwt-assertion');
  if (!token) fail(403, 'forbidden', 'Admin routes require Cloudflare Access.');
  const issuer = `https://${c.env.ACCESS_TEAM_DOMAIN}`;
  jwks ??= createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  const { payload } = await jwtVerify(token, jwks, { issuer, audience: c.env.ACCESS_AUD }).catch(() =>
    fail(403, 'forbidden', 'Invalid Cloudflare Access token.'),
  );
  const identity = typeof payload.email === 'string' ? payload.email : payload.common_name;
  if (typeof identity !== 'string') fail(403, 'forbidden', 'Access token has no identity.');
  c.set('admin', identity);
  await next();
});
