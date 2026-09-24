// Creates the single master agent, or rotates its key and wallet if it exists.
// The key is printed once and only its SHA-256 hash is stored.
// Usage: node --env-file=.env scripts/create-master.mjs --name <name> --wallet 0x... --owner-x <handle> --github <login> [--local]
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    name: { type: 'string' },
    wallet: { type: 'string' },
    'owner-x': { type: 'string' },
    github: { type: 'string' },
    local: { type: 'boolean', default: false },
  },
});

function required(field, pattern) {
  const value = args[field];
  if (!value || !pattern.test(value)) {
    console.error(`--${field} is missing or invalid (${pattern}).`);
    process.exit(1);
  }
  return value;
}

const name = required('name', /^[A-Za-z0-9 ._-]{1,40}$/);
const wallet = required('wallet', /^0x[0-9a-fA-F]{40}$/).toLowerCase();
const ownerX = required('owner-x', /^@?[A-Za-z0-9_]{1,15}$/).replace(/^@/, '').toLowerCase();
const github = required('github', /^[A-Za-z0-9-]{1,39}$/).toLowerCase();

function d1(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'codemarkets-jobs', args.local ? '--local' : '--remote', '--json', '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return JSON.parse(out);
}

// Every interpolated value is validated above to contain no quotes.
const key = `cmk_${randomBytes(32).toString('hex')}`;
const keyHash = createHash('sha256').update(key).digest('hex');
const now = Date.now();
const existing = d1(`SELECT id FROM agents WHERE role = 'master'`)[0].results[0];
const id = existing?.id ?? `ag_${randomBytes(8).toString('hex')}`;
const data = JSON.stringify({ name, wallet });

if (existing) {
  d1(`UPDATE agents SET name = '${name}', owner_x = '${ownerX}', github = '${github}', wallet = '${wallet}', key_hash = '${keyHash}'
      WHERE id = '${id}' AND role = 'master';
      INSERT INTO events (type, public, actor, agent_id, data, created_at)
      SELECT 'master.rotated', 0, 'script', '${id}', '${data}', ${now} WHERE changes() > 0;`);
} else {
  d1(`INSERT INTO agents (id, role, name, owner_x, github, wallet, key_hash, verify_code, verified_at, created_at)
      VALUES ('${id}', 'master', '${name}', '${ownerX}', '${github}', '${wallet}', '${keyHash}', 'MASTER', ${now}, ${now});
      INSERT INTO events (type, public, actor, agent_id, data, created_at)
      SELECT 'master.created', 0, 'script', '${id}', '${data}', ${now} WHERE changes() > 0;`);
}

console.log(`Master ${existing ? 'rotated' : 'created'}: ${id} (${wallet})`);
console.log('Master API key (shown once, give it to the master agent for save_key.py):');
console.log(key);
