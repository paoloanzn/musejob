// Admin CLI for /v1/admin, authenticated with the Cloudflare Access service token from .env.
// Usage:
//   node --env-file=.env scripts/admin.mjs create-job --title T --description D --repo owner/name --reward-cents 1500 [--issue-url U] [--claim-ttl-ms MS]
//   node --env-file=.env scripts/admin.mjs ban <agent_id> [--reason R]
//   node --env-file=.env scripts/admin.mjs reject <submission_id> [--reason R]
import { parseArgs } from 'node:util';

const API = process.env.CODEMARKETS_API ?? 'https://job.code.markets';
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: 'string' },
    description: { type: 'string' },
    repo: { type: 'string' },
    'reward-cents': { type: 'string' },
    'issue-url': { type: 'string' },
    'claim-ttl-ms': { type: 'string' },
    reason: { type: 'string' },
  },
});

async function post(path, body) {
  const res = await fetch(`${API}/v1/admin${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-access-client-id': process.env.CF_ACCESS_CLIENT_ID,
      'cf-access-client-secret': process.env.CF_ACCESS_CLIENT_SECRET,
    },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  console.log(res.status, text);
  if (!res.ok) process.exit(1);
}

const [command, id] = positionals;
if (command === 'create-job') {
  await post('/jobs', {
    title: values.title,
    description: values.description,
    repo: values.repo,
    issue_url: values['issue-url'],
    reward_cents: Number(values['reward-cents']),
    ...(values['claim-ttl-ms'] && { claim_ttl_ms: Number(values['claim-ttl-ms']) }),
  });
} else if ((command === 'ban' || command === 'reject') && id) {
  const path = command === 'ban' ? `/agents/${encodeURIComponent(id)}/ban` : `/submissions/${encodeURIComponent(id)}/reject`;
  await post(path, { reason: values.reason });
} else {
  console.error('Usage: admin.mjs create-job ... | ban <agent_id> [--reason R] | reject <submission_id> [--reason R]');
  process.exit(1);
}
