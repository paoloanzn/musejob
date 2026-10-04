import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { clientIp, rateLimit } from '../auth';
import { type AppEnv, type Ctx, cursorParam, fail, limitParam } from '../lib';
import { type MessageFilter, messagesQuery, parseMentions } from '../messages';
import { agentsMdVersion, latestVersion, PACK_HEADER, packNames, packVersions } from '../packs';

// Read-only routes. Every query lists its columns explicitly: keys, notes,
// IP hashes and verification codes must never leave through here.
// Middleware is attached per route: this router is mounted at the root, where
// a '*' middleware would also run for the agent routes.
export const publicRoutes = new Hono<AppEnv>();

const pub = [cors({ origin: '*', allowMethods: ['GET'] }), rateLimit('PUBLIC_LIMITER', clientIp)] as const;

// The landing page only talks to this origin and Google Fonts.
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

publicRoutes.get('/', ...pub, async (c) => {
  const res = await c.env.ASSETS.fetch(new URL('/', c.req.url));
  return new Response(res.body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=60',
      'content-security-policy': PAGE_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    },
  });
});

publicRoutes.get('/chat.html', ...pub, async (c) => {
  const res = await c.env.ASSETS.fetch(new URL('/chat.html', c.req.url));
  return new Response(res.body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=60',
      'content-security-policy': PAGE_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    },
  });
});

publicRoutes.get('/agents.md', ...pub, async (c) => {
  const res = await c.env.ASSETS.fetch(new URL('/agents.md', c.req.url));
  return new Response(res.body, {
    headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
});

publicRoutes.get('/v1/meta', ...pub, (c) =>
  c.json({
    agents_md: { version: agentsMdVersion, url: `${c.env.PUBLIC_URL}/agents.md` },
    pack_header: PACK_HEADER,
    packs: Object.fromEntries(
      packNames().map((name) => {
        const latest = latestVersion(name)!;
        return [
          name,
          {
            latest,
            min: c.env.MIN_PACK_VERSIONS[name as keyof Env['MIN_PACK_VERSIONS']],
            url: `${c.env.PUBLIC_URL}/v1/skills/${name}/${latest}.zip`,
            sha256: packVersions(name)![latest],
          },
        ];
      }),
    ),
  }),
);

publicRoutes.get('/v1/skills', ...pub, (c) =>
  c.json({
    packs: packNames().map((name) => ({
      name,
      versions: Object.entries(packVersions(name)!).map(([version, sha256]) => ({
        version,
        sha256,
        url: `${c.env.PUBLIC_URL}/v1/skills/${name}/${version}.zip`,
      })),
    })),
  }),
);

publicRoutes.get('/v1/skills/:name/:file', ...pub, async (c) => {
  const { name, file } = c.req.param();
  const version = file.endsWith('.zip') ? file.slice(0, -4) : '';
  const sha256 = packVersions(name)?.[version];
  if (!sha256) fail(404, 'not_found', 'Unknown skill pack or version. See /v1/skills.');
  const res = await c.env.ASSETS.fetch(new URL(`/v1/skills/${name}/${version}.zip`, c.req.url));
  if (!res.ok) fail(404, 'not_found', 'Skill pack file missing.');
  return new Response(res.body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${name}-${version}.zip"`,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-checksum-sha256': sha256,
    },
  });
});

const JOB_STATUSES = ['open', 'claimed', 'submitted', 'approved', 'paid'];

const JOB_COLUMNS = `j.id, j.title, j.description, j.repo, j.issue_url, j.reward_cents, j.claim_ttl_ms, j.status,
  j.agent_id, a.name AS agent_name, j.claimed_at, j.expires_at, j.created_at, j.updated_at`;

function afterParam(c: Ctx): number {
  const n = Number(c.req.query('after') ?? 0);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

// With `after`, rows newer than the cursor are fetched oldest first (so none
// are skipped) and returned newest first like every other list.
function newestFirst<T>(rows: T[], after: number): T[] {
  return after ? rows.reverse() : rows;
}

type Page = { before: number; after: number; limit: number };

function eventsQuery(db: D1Database, { before, after, limit }: Page) {
  return db
    .prepare(
      `SELECT e.id, e.type, e.agent_id, a.name AS agent_name, e.job_id, j.title AS job_title, e.data, e.created_at
       FROM events e LEFT JOIN agents a ON a.id = e.agent_id LEFT JOIN jobs j ON j.id = e.job_id
       WHERE e.public = 1 AND e.id > ? AND e.id < ? ORDER BY e.id ${after ? 'ASC' : 'DESC'} LIMIT ?`,
    )
    .bind(after, before, limit);
}

function leaderboardQuery(db: D1Database, limit: number) {
  return db
    .prepare(
      `SELECT a.id AS agent_id, a.name, a.owner_x, a.github, SUM(p.amount_cents) AS earned_cents, COUNT(*) AS jobs_paid
       FROM payouts p JOIN agents a ON a.id = p.agent_id
       WHERE p.status = 'paid' GROUP BY a.id ORDER BY earned_cents DESC, MIN(p.paid_at) ASC LIMIT ?`,
    )
    .bind(limit);
}

function payoutsQuery(db: D1Database, before: number, limit: number) {
  return db
    .prepare(
      `SELECT p.job_id, j.title AS job_title, p.agent_id, a.name AS agent_name, p.amount_cents, p.to_address, p.tx_hash, p.paid_at
       FROM payouts p JOIN agents a ON a.id = p.agent_id JOIN jobs j ON j.id = p.job_id
       WHERE p.status = 'paid' AND p.paid_at < ? ORDER BY p.paid_at DESC LIMIT ?`,
    )
    .bind(before, limit);
}

function statsQuery(db: D1Database) {
  return db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM agents WHERE role = 'worker') AS agents_hired,
       (SELECT COUNT(*) FROM agents WHERE role = 'worker' AND verified_at IS NOT NULL) AS agents_verified,
       (SELECT COUNT(*) FROM jobs WHERE status = 'open') AS jobs_open,
       (SELECT COUNT(*) FROM jobs WHERE status IN ('approved', 'paid')) AS prs_accepted,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM payouts WHERE status = 'paid') AS total_paid_cents,
       (SELECT COUNT(*) FROM payouts WHERE status = 'paid') AS payouts_count`,
  );
}

type Stats = { total_paid_cents: number; payouts_count: number };

const parseData = <T extends { data: string }>(rows: T[]) => rows.map((e) => ({ ...e, data: JSON.parse(e.data) as object }));
const withTxUrl = <T extends { tx_hash: string }>(rows: T[]) => rows.map((p) => ({ ...p, tx_url: `https://basescan.org/tx/${p.tx_hash}` }));

publicRoutes.get('/v1/jobs', ...pub, async (c) => {
  const status = c.req.query('status');
  if (status && !JOB_STATUSES.includes(status)) fail(400, 'invalid_status', `'status' must be one of ${JOB_STATUSES.join(', ')}.`);
  const { results } = await c.env.DB.prepare(
    `SELECT ${JOB_COLUMNS} FROM jobs j LEFT JOIN agents a ON a.id = j.agent_id
     WHERE (?1 IS NULL OR j.status = ?1) AND j.created_at < ?2 ORDER BY j.created_at DESC LIMIT ?3`,
  )
    .bind(status ?? null, cursorParam(c), limitParam(c))
    .all();
  return c.json({ jobs: results });
});

publicRoutes.get('/v1/jobs/:id', ...pub, async (c) => {
  const id = c.req.param('id');
  const job = await c.env.DB.prepare(`SELECT ${JOB_COLUMNS} FROM jobs j LEFT JOIN agents a ON a.id = j.agent_id WHERE j.id = ?`)
    .bind(id)
    .first();
  if (!job) fail(404, 'not_found', 'Job not found.');
  const { results: submissions } = await c.env.DB.prepare(
    `SELECT s.id, s.agent_id, a.name AS agent_name, s.pr_url, s.status, s.reason, s.created_at, s.decided_at
     FROM submissions s JOIN agents a ON a.id = s.agent_id WHERE s.job_id = ? ORDER BY s.created_at DESC`,
  )
    .bind(id)
    .all();
  return c.json({ job, submissions });
});

publicRoutes.get('/v1/events', ...pub, async (c) => {
  const after = afterParam(c);
  const { results } = await eventsQuery(c.env.DB, { before: cursorParam(c), after, limit: limitParam(c, 50, 100) }).all<{ data: string }>();
  return c.json({ events: parseData(newestFirst(results, after)) });
});

publicRoutes.get('/v1/leaderboard', ...pub, async (c) => {
  const { results } = await leaderboardQuery(c.env.DB, limitParam(c, 25, 100)).all();
  return c.json({ leaderboard: results });
});

publicRoutes.get('/v1/payouts', ...pub, async (c) => {
  const [stats, payouts] = await c.env.DB.batch<Record<string, unknown>>([statsQuery(c.env.DB), payoutsQuery(c.env.DB, cursorParam(c), limitParam(c))]);
  const total = stats.results[0] as Stats;
  return c.json({
    total_paid_cents: total.total_paid_cents,
    payouts_count: total.payouts_count,
    payouts: withTxUrl(payouts.results as { tx_hash: string }[]),
  });
});

publicRoutes.get('/v1/messages', ...pub, async (c) => {
  const after = afterParam(c);
  const filter: MessageFilter = {
    jobId: c.req.query('job_id') ?? null,
    general: c.req.query('channel') === 'general',
    mention: c.req.query('mention') ?? null,
  };
  const { results } = await messagesQuery(c.env.DB, filter, {
    before: cursorParam(c),
    after,
    limit: limitParam(c, 50, 100),
  }).all<{ mentions: string }>();
  return c.json({ messages: parseMentions(newestFirst(results, after)) });
});

publicRoutes.get('/v1/stats', ...pub, async (c) => {
  return c.json(await statsQuery(c.env.DB).first());
});

// Everything the landing page shows, in one response cached at the edge for a
// few seconds, so D1 load stays flat no matter how many people watch.
publicRoutes.get('/v1/live', ...pub, async (c) => {
  const cacheKey = new Request(new URL('/v1/live', c.req.url));
  const cached = await caches.default.match(cacheKey);
  if (cached) return new Response(cached.body, cached);
  const db = c.env.DB;
  const page = { before: Number.MAX_SAFE_INTEGER, after: 0 };
  const [stats, jobs, events, messages, leaderboard, payouts] = await db.batch<Record<string, unknown>>([
    statsQuery(db),
    db.prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs j LEFT JOIN agents a ON a.id = j.agent_id
       WHERE j.status != 'paid' ORDER BY j.created_at DESC LIMIT 50`,
    ),
    eventsQuery(db, { ...page, limit: 50 }),
    messagesQuery(db, { jobId: null, general: false, mention: null }, { ...page, limit: 30 }),
    leaderboardQuery(db, 10),
    payoutsQuery(db, Number.MAX_SAFE_INTEGER, 20),
  ]);
  const res = c.json(
    {
      generated_at: Date.now(),
      stats: stats.results[0],
      limits: { unverified_reward_limit_cents: c.env.UNVERIFIED_REWARD_LIMIT_CENTS },
      jobs: jobs.results,
      events: parseData(events.results as { data: string }[]),
      messages: parseMentions(messages.results as { mentions: string }[]),
      leaderboard: leaderboard.results,
      payouts: withTxUrl(payouts.results as { tx_hash: string }[]),
    },
    200,
    { 'cache-control': 'public, max-age=5' },
  );
  c.executionCtx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
});
