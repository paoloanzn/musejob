import type { Context } from 'hono';

export type Agent = {
  id: string;
  role: 'worker' | 'master';
  status: 'active' | 'banned';
  name: string;
  owner_x: string;
  github: string;
  wallet: string;
  verify_code: string;
  verified_at: number | null;
  verified_tweet: string | null;
  created_at: number;
};

export type AppEnv = { Bindings: Env; Variables: { agent: Agent; admin: string } };
export type Ctx = Context<AppEnv>;

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 426 | 429 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function fail(status: ApiError['status'], code: string, message: string): never {
  throw new ApiError(status, code, message);
}

const HEX = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export function randomHex(byteCount: number): string {
  return HEX(crypto.getRandomValues(new Uint8Array(byteCount)));
}

export function newId(prefix: string): string {
  return `${prefix}_${randomHex(8)}`;
}

export function newApiKey(): string {
  return `cmk_${randomHex(32)}`;
}

// Short code the owner tweets; no ambiguous characters (0/O, 1/I).
export function newVerifyCode(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return 'CM-' + [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  return HEX(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

export function tweetText(code: string): string {
  return `My Muse agent is applying for a job at code.markets. Verification code: ${code} https://job.code.markets`;
}

export function startOfUtcDay(now: number): number {
  return now - (now % 86_400_000);
}

export function usdc(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// Appends an event row that is written only if the statement just before it
// in the same batch changed at least one row, so the ledger and the event log
// can never disagree.
export function event(
  db: D1Database,
  e: { type: string; public: boolean; actor: string; agentId?: string | null; jobId?: string | null; data?: object },
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO events (type, public, actor, agent_id, job_id, data, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0`,
    )
    .bind(e.type, e.public ? 1 : 0, e.actor, e.agentId ?? null, e.jobId ?? null, JSON.stringify(e.data ?? {}), now);
}

export function isUniqueViolation(err: unknown, column: string): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed') && err.message.includes(column);
}

export async function readBody(c: Ctx): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_json', 'Request body must be a JSON object.');
  return body as Record<string, unknown>;
}

export function str(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) fail(400, 'invalid_field', `'${field}' is required.`);
  const trimmed = value.trim();
  if (trimmed.length > max) fail(400, 'invalid_field', `'${field}' must be at most ${max} characters.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) fail(400, 'invalid_field', `'${field}' contains control characters.`);
  return trimmed;
}

export function optionalStr(body: Record<string, unknown>, field: string, max: number): string | null {
  return body[field] === undefined || body[field] === null || body[field] === '' ? null : str(body, field, max);
}

export function match(value: string, field: string, pattern: RegExp, hint: string): string {
  if (!pattern.test(value)) fail(400, 'invalid_field', `'${field}' ${hint}.`);
  return value;
}

export const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
export const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
export const GITHUB_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function walletField(body: Record<string, unknown>): string {
  return match(str(body, 'wallet', 42), 'wallet', WALLET_RE, 'must be a 0x EVM address').toLowerCase();
}

export function limitParam(c: Ctx, def = 50, max = 200): number {
  const n = Number(c.req.query('limit') ?? def);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
}

export function cursorParam(c: Ctx, name = 'before'): number {
  const n = Number(c.req.query(name) ?? Number.MAX_SAFE_INTEGER);
  return Number.isSafeInteger(n) && n > 0 ? n : Number.MAX_SAFE_INTEGER;
}
