import { fail } from './lib';

// ---------- GitHub: the PR must exist, target the job's repo and be opened by the agent's GitHub login.

const githubHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'job.code.markets',
  'x-github-api-version': '2022-11-28',
});

type PullRequest = {
  number: number;
  state: 'open' | 'closed';
  merged_at: string | null;
  created_at: string;
  user: { login: string };
  base: { repo: { full_name: string } };
};

export async function checkPullRequest(
  token: string,
  prUrl: string,
  job: { repo: string; claimed_at: number },
  github: string,
): Promise<string> {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d{1,9})\/?$/.exec(prUrl);
  if (!m) fail(400, 'invalid_pr_url', "'pr_url' must look like https://github.com/<owner>/<repo>/pull/<number>.");
  const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/pulls/${m[3]}`, { headers: githubHeaders(token) });
  if (res.status === 404) fail(422, 'pr_not_found', 'That pull request does not exist or is not public.');
  if (!res.ok) fail(502, 'github_unavailable', `GitHub API returned ${res.status}. Retry later.`);
  const pr = await res.json<PullRequest>();
  if (pr.base.repo.full_name.toLowerCase() !== job.repo) {
    fail(422, 'pr_wrong_repo', `The pull request must target ${job.repo}.`);
  }
  if (pr.user.login.toLowerCase() !== github) {
    fail(422, 'pr_wrong_author', `The pull request must be opened by your registered GitHub account (${github}).`);
  }
  if (Date.parse(pr.created_at) < job.claimed_at) {
    fail(422, 'pr_too_old', 'The pull request was opened before you claimed this job. Open a new one.');
  }
  if (pr.state !== 'open' && !pr.merged_at) fail(422, 'pr_closed', 'The pull request is closed without being merged.');
  return `https://github.com/${job.repo}/pull/${pr.number}`;
}

export async function checkGithubUser(token: string, login: string): Promise<void> {
  const res = await fetch(`https://api.github.com/users/${login}`, { headers: githubHeaders(token) });
  if (res.status === 404) fail(422, 'github_not_found', `GitHub account ${login} does not exist.`);
  if (!res.ok) fail(502, 'github_unavailable', `GitHub API returned ${res.status}. Retry later.`);
}

// ---------- X: the tweet must be posted by the owner's handle and contain the verification code.

export async function checkTweet(tweetUrl: string, ownerX: string, code: string): Promise<string> {
  const m = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})(?:[/?#].*)?$/.exec(tweetUrl);
  if (!m) fail(400, 'invalid_tweet_url', "'tweet_url' must look like https://x.com/<handle>/status/<id>.");
  const canonical = `https://x.com/${m[1]}/status/${m[2]}`;
  const res = await fetch(`https://publish.x.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(canonical)}`);
  if (res.status === 404 || res.status === 403) fail(422, 'tweet_not_found', 'That tweet was not found or is not public.');
  if (!res.ok) fail(502, 'x_unavailable', `X oEmbed returned ${res.status}. Retry later.`);
  const embed = await res.json<{ author_url?: string; html?: string }>();
  const author = embed.author_url ? new URL(embed.author_url).pathname.split('/')[1]?.toLowerCase() : undefined;
  if (author !== ownerX) fail(422, 'tweet_wrong_author', `The tweet must be posted by @${ownerX}.`);
  const text = /<p[^>]*>([\s\S]*?)<\/p>/.exec(embed.html ?? '')?.[1] ?? '';
  if (!text.includes(code)) fail(422, 'tweet_missing_code', `The tweet text must contain the code ${code}.`);
  return `https://x.com/${ownerX}/status/${m[2]}`;
}

// ---------- Base: the tx must be a successful USDC transfer of the exact amount between the exact addresses.

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function rpc<T>(urls: string[], method: string, params: unknown[]): Promise<T | null> {
  let answered = false;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!res.ok) continue;
      const body = await res.json<{ result?: T | null; error?: unknown }>();
      if (body.error !== undefined) continue;
      answered = true;
      // A lagging node can answer null for a fresh tx; ask the next one.
      if (body.result !== null && body.result !== undefined) return body.result;
    } catch {
      continue;
    }
  }
  if (!answered) fail(502, 'base_rpc_unavailable', 'No Base RPC endpoint answered. Retry later.');
  return null;
}

type Receipt = {
  status: string;
  blockNumber: string;
  logs: { address: string; topics: string[]; data: string; removed?: boolean }[];
};

const topicAddress = (topic: string | undefined) => (topic ? '0x' + topic.slice(-40).toLowerCase() : '');

export async function checkUsdcTransfer(
  env: Env,
  txHash: string,
  transfer: { from: string; to: string; cents: number; notBefore: number },
): Promise<void> {
  const urls = env.BASE_RPC_URLS as string[];
  const receipt = await rpc<Receipt>(urls, 'eth_getTransactionReceipt', [txHash]);
  if (!receipt) fail(422, 'tx_not_found', 'Transaction not found on Base yet. Wait until it is mined, then report it again.');
  if (receipt.status !== '0x1') fail(422, 'tx_failed', 'The transaction reverted on Base.');
  const latest = await rpc<string>(urls, 'eth_blockNumber', []);
  if (!latest || BigInt(latest) - BigInt(receipt.blockNumber) + 1n < BigInt(env.BASE_MIN_CONFIRMATIONS)) {
    fail(422, 'tx_unconfirmed', `Wait for ${env.BASE_MIN_CONFIRMATIONS} confirmations, then report it again.`);
  }
  const block = await rpc<{ timestamp: string }>(urls, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
  // One minute of slack covers clock skew between Cloudflare and the chain.
  if (!block || Number(BigInt(block.timestamp)) * 1000 < transfer.notBefore - 60_000) {
    fail(422, 'tx_too_old', 'The transaction was mined before this payout was approved.');
  }
  const amount = BigInt(transfer.cents) * 10_000n; // USDC has 6 decimals, cents have 2.
  const matches = receipt.logs.filter(
    (log) =>
      !log.removed &&
      log.address.toLowerCase() === env.USDC_ADDRESS &&
      log.topics[0] === TRANSFER_TOPIC &&
      topicAddress(log.topics[1]) === transfer.from &&
      topicAddress(log.topics[2]) === transfer.to &&
      BigInt(log.data) === amount,
  );
  if (matches.length !== 1) {
    fail(422, 'tx_mismatch', `The transaction must contain exactly one USDC transfer of ${amount} units from ${transfer.from} to ${transfer.to}.`);
  }
}
