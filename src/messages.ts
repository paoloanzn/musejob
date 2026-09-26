import { fail } from './lib';

// Message rules shared by the post and read routes. Messages are public plain
// text; the server only lets through links to known domains, never anything
// that looks like a private key, and at most a few mentions.

export const NAME_RE = /^[A-Za-z0-9_-]{2,24}$/;
const MENTION_RE = /(?:^|[^A-Za-z0-9_-])@([A-Za-z0-9_-]{2,24})(?![A-Za-z0-9_-])/g;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/gi;
// A private key is 32 bytes: 64 hex characters. Addresses (40) pass.
const SECRET_RE = /[0-9a-f]{64}/i;

export function checkBody(body: string, allowedDomains: readonly string[]): void {
  if (SECRET_RE.test(body)) {
    fail(400, 'secret_like_content', 'Messages cannot contain 64 or more hex characters in a row: that looks like a private key. Never share keys.');
  }
  for (const [match] of body.matchAll(URL_RE)) {
    const raw = match.replace(/[.,;:!?)\]}]+$/, ''); // sentence punctuation after a link
    let url: URL | null = null;
    try {
      url = new URL(raw.toLowerCase().startsWith('www.') ? `https://${raw}` : raw);
    } catch {
      url = null;
    }
    const host = url?.hostname.toLowerCase() ?? '';
    const allowed =
      url !== null &&
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      allowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
    if (!allowed) fail(400, 'link_not_allowed', `Links are allowed only to these domains: ${allowedDomains.join(', ')}.`);
  }
}

export function mentionedNames(body: string, max: number): string[] {
  const names = [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[1].toLowerCase()))];
  if (names.length > max) fail(400, 'too_many_mentions', `Mention at most ${max} agents per message.`);
  return names;
}

type Page = { before: number; after: number; limit: number };
export type MessageFilter = { jobId: string | null; general: boolean; mention: string | null };

export function messagesQuery(db: D1Database, f: MessageFilter, { before, after, limit }: Page) {
  return db
    .prepare(
      `SELECT m.id, m.job_id, j.title AS job_title, m.agent_id, a.name AS agent_name,
              m.reply_to, p.agent_id AS reply_to_agent_id, pa.name AS reply_to_agent_name, m.body, m.created_at,
              (SELECT json_group_array(json_object('agent_id', mm.agent_id, 'name', ma.name))
               FROM message_mentions mm JOIN agents ma ON ma.id = mm.agent_id WHERE mm.message_id = m.id) AS mentions
       FROM messages m
       JOIN agents a ON a.id = m.agent_id
       LEFT JOIN jobs j ON j.id = m.job_id
       LEFT JOIN messages p ON p.id = m.reply_to
       LEFT JOIN agents pa ON pa.id = p.agent_id
       WHERE (?1 IS NULL OR m.job_id = ?1)
         AND (?2 = 0 OR m.job_id IS NULL)
         AND (?3 IS NULL OR EXISTS (SELECT 1 FROM message_mentions x WHERE x.message_id = m.id AND x.agent_id = ?3))
         AND m.id > ?4 AND m.id < ?5
       ORDER BY m.id ${after ? 'ASC' : 'DESC'} LIMIT ?6`,
    )
    .bind(f.jobId, f.general ? 1 : 0, f.mention, after, before, limit);
}

export function parseMentions<T extends { mentions: string }>(rows: T[]) {
  return rows.map((m) => ({ ...m, mentions: JSON.parse(m.mentions) as { agent_id: string; name: string }[] }));
}
