// Zips each skill pack at the version in packs/packs.json.
// Public packs go to public/v1/skills/<name>/<version>.zip and are served by the Worker;
// private packs go to dist/<name>-<version>.zip and are handed over manually.
// A published version never changes: if its zip exists with different content, the build fails.
// Finally writes src/manifest.json with every published version and its SHA-256.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';

const ROOT = new URL('..', import.meta.url).pathname;
const packs = JSON.parse(readFileSync(join(ROOT, 'packs/packs.json'), 'utf8'));
const FIXED_MTIME = new Date('2026-01-01T00:00:00Z');

function listFiles(dir) {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.') && name !== '__pycache__')
    .flatMap((name) => (statSync(join(dir, name)).isDirectory() ? listFiles(join(dir, name)) : [join(dir, name)]));
}

function buildZip(name) {
  const dir = join(ROOT, 'packs', name);
  const entries = {};
  for (const file of listFiles(dir).sort()) {
    const mode = file.endsWith('.sh') ? 0o755 : 0o644;
    entries[`${name}/${relative(dir, file)}`] = [readFileSync(file), { mtime: FIXED_MTIME, os: 3, attrs: (0o100000 | mode) << 16 }];
  }
  return Buffer.from(zipSync(entries, { level: 9 }));
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

for (const [name, { version, public: isPublic }] of Object.entries(packs)) {
  const target = isPublic ? join(ROOT, 'public/v1/skills', name, `${version}.zip`) : join(ROOT, 'dist', `${name}-${version}.zip`);
  const zip = buildZip(name);
  if (existsSync(target)) {
    if (!readFileSync(target).equals(zip)) {
      console.error(`${name} ${version} is already published with different content. Bump its version in packs/packs.json.`);
      process.exit(1);
    }
    console.log(`${name} ${version} unchanged`);
    continue;
  }
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, zip);
  console.log(`${name} ${version} written (${sha256(zip)})`);
}

const manifest = { agents_md_version: '', packs: {} };
const agentsMd = readFileSync(join(ROOT, 'public/agents.md'), 'utf8');
manifest.agents_md_version = /^version:\s*(\S+)\s*$/m.exec(agentsMd)?.[1] ?? '';
if (!manifest.agents_md_version) {
  console.error('public/agents.md needs a "version: x.y.z" line in its front matter.');
  process.exit(1);
}
const skillsDir = join(ROOT, 'public/v1/skills');
for (const name of readdirSync(skillsDir).sort()) {
  manifest.packs[name] = {};
  for (const file of readdirSync(join(skillsDir, name)).filter((f) => f.endsWith('.zip')).sort()) {
    manifest.packs[name][file.slice(0, -4)] = sha256(readFileSync(join(skillsDir, name, file)));
  }
}
writeFileSync(join(ROOT, 'src/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('src/manifest.json updated');
