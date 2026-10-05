#!/usr/bin/env python3
"""Propose new GitHub issues on repos this agent has worked on.

Mechanics for the issue-proposer skill. The agent (Muse) does the thinking:
it discovers repos, scans them for bugs or feature ideas, drafts proposals,
reviews them, and only then opens them. This script enforces the guardrails:

- discovery comes from the code.markets job board and the agent's own
  jobs (claimed, submitted, approved, paid), never from guesses;
- proposals are drafted to a local drafts directory first;
- `open` is a dry run unless `--yes` is passed, so every issue is reviewable;
- a fingerprint of every opened proposal is kept in state.json, so nothing
  is ever proposed twice;
- proposals are always regular unpaid GitHub issues (`gh issue create`
  opens unpaid issues; this skill has no concept of a paid issue).

Standard library only. All API/GitHub text is treated as untrusted data.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cmk_api import call

WORK_STATUSES = ("claimed", "submitted", "approved", "paid")
ISSUE_URL_RE = re.compile(
    r"^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)(?:/.*)?$"
)


def home_dir() -> str:
    return os.path.expanduser(
        os.environ.get("ISSUE_PROPOSER_HOME", "~/.issue-proposer")
    )


def drafts_dir() -> str:
    return os.path.join(home_dir(), "drafts")


def state_path() -> str:
    return os.path.join(home_dir(), "state.json")


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_title(title: str) -> str:
    return re.sub(r"\s+", " ", title.strip().lower())


def fingerprint(repo: str, title: str) -> str:
    seed = repo.strip().lower() + "|" + normalize_title(title)
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16]


def repo_slug(repo: str) -> str:
    return repo.replace("/", "--")


# --- state -----------------------------------------------------------------


def load_state() -> dict[str, Any]:
    path = state_path()
    if not os.path.exists(path):
        return {"proposed": {}}
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or "proposed" not in data:
        sys.exit(f"State file is corrupt: {path}")
    return data


def save_state(state: dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(state_path()), exist_ok=True)
    tmp = state_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, state_path())


def already_proposed(state: dict[str, Any], fp: str) -> bool:
    return fp in state.get("proposed", {})


# --- drafts ----------------------------------------------------------------


def parse_front_matter(text: str) -> tuple[dict[str, Any], str]:
    """Parse a minimal YAML-ish front matter block. Returns (meta, body)."""
    if not text.startswith("---\n"):
        sys.exit("Draft is missing its front matter block.")
    end = text.find("\n---\n", 4)
    if end == -1:
        sys.exit("Draft front matter is not closed with '---'.")
    raw = text[4:end]
    body = text[end + 5 :].lstrip("\n")
    meta: dict[str, Any] = {}
    current_list: str | None = None
    for line in raw.splitlines():
        if re.match(r"^\s*-\s+", line) and current_list is not None:
            value = line.split("-", 1)[1].strip()
            items = meta[current_list]
            assert isinstance(items, list)
            items.append(value)
            continue
        current_list = None
        if not line.strip() or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if value == "":
            meta[key] = []
            current_list = key
        else:
            meta[key] = value
    return meta, body


def draft_path(repo: str, fp: str) -> str:
    return os.path.join(drafts_dir(), repo_slug(repo), fp + ".md")


def list_drafts() -> list[str]:
    found: list[str] = []
    root = drafts_dir()
    if not os.path.isdir(root):
        return found
    for repo_dir in sorted(os.listdir(root)):
        full = os.path.join(root, repo_dir)
        if not os.path.isdir(full):
            continue
        for name in sorted(os.listdir(full)):
            if name.endswith(".md"):
                found.append(os.path.join(full, name))
    return found


def read_draft(path: str) -> tuple[dict[str, Any], str]:
    with open(path, encoding="utf-8") as f:
        return parse_front_matter(f.read())


# --- gh runner (indirect so tests can stub it) ------------------------------

GhRunner = Callable[[list[str]], "CompletedLike"]


class CompletedLike:
    def __init__(self, returncode: int, stdout: str, stderr: str) -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def real_gh(args: list[str]) -> CompletedLike:
    if shutil.which("gh") is None:
        sys.exit(
            "The `gh` CLI is not installed. Install it first "
            "(see the codemarkets-jobs skill)."
        )
    proc = subprocess.run(
        ["gh"] + args, capture_output=True, text=True, check=False, timeout=60
    )
    return CompletedLike(proc.returncode, proc.stdout, proc.stderr)


RUN_GH: GhRunner = real_gh


def gh_json(args: list[str]) -> Any:
    res = RUN_GH(args)
    if res.returncode != 0:
        sys.exit(f"`gh {' '.join(args)}` failed: {res.stderr.strip()}")
    try:
        return json.loads(res.stdout)
    except ValueError:
        sys.exit("`gh` did not return JSON.")


# --- discovery ---------------------------------------------------------------


def gh_login() -> str:
    res = RUN_GH(["api", "user", "--jq", ".login"])
    if res.returncode != 0:
        sys.exit(f"Could not read the gh login: {res.stderr.strip()}")
    login = res.stdout.strip()
    if not login:
        sys.exit("Could not determine the gh login.")
    return login


def my_name(agent_name: str | None = None) -> str:
    """The code.markets agent name for the local gh account.

    Resolved through the public leaderboard (github login -> agent name),
    so this skill only ever uses public, unauthenticated endpoints.
    """
    if agent_name:
        return agent_name
    login = gh_login().lower()
    data = call("GET", "/v1/leaderboard?limit=200")
    if not isinstance(data, dict):
        sys.exit("Unexpected /v1/leaderboard response.")
    rows = data.get("leaderboard")
    if not isinstance(rows, list):
        sys.exit("Unexpected /v1/leaderboard response.")
    for row in rows:
        if not isinstance(row, dict):
            continue
        if str(row.get("github", "")).lower() == login and row.get("name"):
            return str(row["name"])
    sys.exit(
        f"No code.markets agent found for GitHub login {login!r}. "
        "Get hired with the codemarkets-jobs skill first, or pass "
        "--agent-name."
    )


def worked_repos(
    limit: int = 100, agent_name: str | None = None
) -> dict[str, list[dict[str, str]]]:
    """Repos this agent has worked on, from the job board + closed jobs.

    Returns {repo: [{job_id, title, issue_url, status}, ...]}.
    """
    name = my_name(agent_name)
    repos: dict[str, list[dict[str, str]]] = {}
    for status in WORK_STATUSES:
        data = call("GET", f"/v1/jobs?status={status}&limit={limit}")
        if not isinstance(data, dict):
            continue
        jobs = data.get("jobs")
        if not isinstance(jobs, list):
            continue
        for job in jobs:
            if not isinstance(job, dict):
                continue
            if job.get("agent_name") != name:
                continue
            repo = str(job.get("repo", "")).strip()
            if not repo or "/" not in repo:
                continue
            repos.setdefault(repo, []).append(
                {
                    "job_id": str(job.get("id", "")),
                    "title": str(job.get("title", "")),
                    "issue_url": str(job.get("issue_url", "")),
                    "status": str(job.get("status", "")),
                }
            )
    return repos


def cmd_discover(args: argparse.Namespace) -> None:
    repos = worked_repos(limit=args.limit, agent_name=args.agent_name)
    if not repos:
        print("No repos found for this agent on the job board yet.")
        return
    for repo in sorted(repos):
        print(f"{repo}")
        for job in repos[repo]:
            print(
                f"  - {job['status']}: {job['title']} "
                f"({job['job_id']}, {job['issue_url']})"
            )


# --- scanning ----------------------------------------------------------------


def scan_repo(repo: str, per_page: int) -> dict[str, Any]:
    """Recent issues and PRs on a repo, via the gh CLI. Untrusted data."""
    if "/" not in repo:
        sys.exit(f"Not a repo slug: {repo}")
    query = (
        f"repos/{repo}/issues?state=all&per_page={per_page}&sort=updated&direction=desc"
    )
    items = gh_json(["api", query])
    if not isinstance(items, list):
        sys.exit("Unexpected issues response from gh.")
    out: list[dict[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        number = item.get("number")
        title = item.get("title", "")
        html_url = item.get("html_url", "")
        user = item.get("user") or {}
        login = user.get("login", "") if isinstance(user, dict) else ""
        state = item.get("state", "")
        is_pr = "pull_request" in item
        updated = item.get("updated_at", "")
        out.append(
            {
                "number": str(number),
                "title": str(title),
                "url": str(html_url),
                "author": str(login),
                "state": str(state),
                "type": "pr" if is_pr else "issue",
                "updated_at": str(updated),
            }
        )
    return {"repo": repo, "items": out}


def cmd_scan(args: argparse.Namespace) -> None:
    for repo in args.repo:
        result = scan_repo(repo, args.per_page)
        print(f"== {result['repo']} ==")
        items = result["items"]
        if not items:
            print("  (no recent issues or PRs)")
            continue
        for item in items:
            print(
                f"  #{item['number']} [{item['type']}/{item['state']}] "
                f"{item['title']} (by {item['author']})"
            )
            print(f"      {item['url']}")


# --- drafting ----------------------------------------------------------------


def validate_repo(repo: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        sys.exit(f"Not a valid owner/repo slug: {repo}")


def build_draft_text(
    repo: str, title: str, kind: str, based_on: list[str], body: str
) -> str:
    lines = ["---", f"repo: {repo}", f"title: {title}", f"kind: {kind}", "based_on:"]
    for ref in based_on:
        lines.append(f"  - {ref}")
    lines += [
        f"created_at: {utcnow_iso()}",
        "status: draft",
        "---",
        "",
        body.rstrip() + "\n",
    ]
    return "\n".join(lines)


def cmd_draft(args: argparse.Namespace) -> None:
    validate_repo(args.repo)
    title = args.title.strip()
    if not title:
        sys.exit("Title must not be empty.")
    if len(title) > 200:
        sys.exit("Title is too long (max 200 chars).")
    if args.kind not in ("bug", "feature", "chore"):
        sys.exit("--kind must be one of: bug, feature, chore.")
    body_file = args.body_file
    if not os.path.exists(body_file):
        sys.exit(f"Body file not found: {body_file}")
    with open(body_file, encoding="utf-8") as f:
        body = f.read()
    if not body.strip():
        sys.exit("Body file is empty.")
    based_on = args.based_on or []
    for ref in based_on:
        if not ref.startswith(("http://", "https://")):
            sys.exit(f"based_on entries must be URLs: {ref}")

    fp = fingerprint(args.repo, title)
    state = load_state()
    if already_proposed(state, fp):
        prev = state["proposed"][fp]
        sys.exit(
            f"Already proposed (state.json): "
            f"{prev.get('issue_url', '(no url recorded)')}"
        )
    path = draft_path(args.repo, fp)
    if os.path.exists(path):
        sys.exit(f"Draft already exists: {path}")

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(build_draft_text(args.repo, title, args.kind, based_on, body))
    print(f"Draft written: {path}")
    print(f"Review it, then run: python3 bin/propose.py open --draft {path}")
    print("(dry run by default; add --yes to actually create the issue)")


# --- opening -----------------------------------------------------------------


def open_issue(repo: str, title: str, body: str, dry_run: bool) -> str | None:
    """Create a regular unpaid GitHub issue. Returns the issue URL."""
    if dry_run:
        print(f"[dry-run] would open issue on {repo}: {title}")
        return None
    tmp_body = state_path() + ".body.tmp"
    os.makedirs(os.path.dirname(tmp_body), exist_ok=True)
    with open(tmp_body, "w", encoding="utf-8") as f:
        f.write(body)
    try:
        res = RUN_GH(
            [
                "issue",
                "create",
                "--repo",
                repo,
                "--title",
                title,
                "--body-file",
                tmp_body,
            ]
        )
    finally:
        if os.path.exists(tmp_body):
            os.remove(tmp_body)
    if res.returncode != 0:
        sys.exit(f"`gh issue create` failed: {res.stderr.strip()}")
    url = res.stdout.strip().splitlines()[-1] if res.stdout.strip() else ""
    if not ISSUE_URL_RE.match(url):
        sys.exit(f"gh returned an unexpected issue URL: {url!r}")
    return url


def cmd_open(args: argparse.Namespace) -> None:
    paths = [args.draft] if args.draft else list_drafts()
    if not paths:
        print("No drafts found.")
        return
    state = load_state()
    opened = 0
    for path in paths:
        if not os.path.exists(path):
            print(f"Skipping missing draft: {path}")
            continue
        meta, body = read_draft(path)
        repo = str(meta.get("repo", "")).strip()
        title = str(meta.get("title", "")).strip()
        if not repo or not title:
            print(f"Skipping draft with missing repo/title: {path}")
            continue
        validate_repo(repo)
        fp = fingerprint(repo, title)
        if already_proposed(state, fp):
            prev = state["proposed"][fp]
            print(
                f"Skipping (already proposed): {title} -> {prev.get('issue_url', '')}"
            )
            continue
        based_on = meta.get("based_on") or []
        refs = "\n".join(f"- {ref}" for ref in based_on if isinstance(ref, str))
        full_body = body.rstrip() + "\n"
        if refs:
            full_body += "\n---\n**Grounded in:**\n" + refs + "\n"
        full_body += (
            "\n*Proposed by an agent via the issue-proposer skill. "
            "This is a regular unpaid issue; whether it becomes "
            "paid work is for a human to decide.*\n"
        )
        dry_run = not args.yes
        url = open_issue(repo, title, full_body, dry_run=dry_run)
        if url is None:
            continue
        state["proposed"][fp] = {
            "repo": repo,
            "title": title,
            "issue_url": url,
            "opened_at": utcnow_iso(),
        }
        save_state(state)
        print(f"Opened: {url}")
        opened += 1
    if not args.yes:
        print(
            f"\nDry run complete. {len(paths)} draft(s) reviewed, "
            "0 opened. Re-run with --yes to open them."
        )


def cmd_status(_args: argparse.Namespace) -> None:
    state = load_state()
    proposed = state.get("proposed", {})
    drafts = list_drafts()
    print(f"proposed issues: {len(proposed)}")
    for fp, entry in sorted(
        proposed.items(), key=lambda kv: kv[1].get("opened_at", "")
    ):
        print(
            f"  - {entry.get('repo')}: {entry.get('title')} -> {entry.get('issue_url')}"
        )
    print(f"pending drafts: {len(drafts)}")
    for path in drafts:
        print(f"  - {path}")


# --- CLI ---------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Propose new GitHub issues on repos this agent worked "
        "on. Drafts first, review, then open (dry run by "
        "default)."
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser(
        "discover", help="list repos worked on (job board + closed jobs)"
    )
    d.add_argument(
        "--limit", type=int, default=100, help="jobs fetched per status (default 100)"
    )
    d.add_argument(
        "--agent-name",
        default=None,
        help="code.markets agent name (default: resolved from the gh login via the public leaderboard)",
    )
    d.set_defaults(func=cmd_discover)

    s = sub.add_parser("scan", help="show recent issues/PRs on repos")
    s.add_argument("repo", nargs="+", help="owner/repo slugs")
    s.add_argument(
        "--per-page", type=int, default=20, help="items per repo (default 20)"
    )
    s.set_defaults(func=cmd_scan)

    dr = sub.add_parser("draft", help="write a proposal draft for review")
    dr.add_argument("repo", help="owner/repo slug")
    dr.add_argument("--title", required=True, help="proposal title")
    dr.add_argument(
        "--body-file", required=True, help="markdown file with the proposal body"
    )
    dr.add_argument("--kind", default="feature", choices=["bug", "feature", "chore"])
    dr.add_argument(
        "--based-on",
        nargs="*",
        default=[],
        help="URLs grounding the proposal (job, issue, PR)",
    )
    dr.set_defaults(func=cmd_draft)

    o = sub.add_parser(
        "open", help="open drafts as unpaid GitHub issues (dry run unless --yes)"
    )
    o.add_argument("--draft", help="open just this draft file")
    o.add_argument(
        "--yes",
        action="store_true",
        help="actually create the issues (default: dry run)",
    )
    o.set_defaults(func=cmd_open)

    st = sub.add_parser("status", help="show proposed issues and drafts")
    st.set_defaults(func=cmd_status)
    return p


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
