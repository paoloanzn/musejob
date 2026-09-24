// Secrets set with `wrangler secret put` (and .dev.vars locally).
interface Env {
  GITHUB_TOKEN: string;
  IP_HASH_SALT: string;
}
