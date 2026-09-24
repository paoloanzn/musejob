#!/usr/bin/env python3
"""List, inspect, claim, release and submit code.markets jobs."""
import argparse
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api import call, show  # noqa: E402


def job_path(job_id, action=""):
    return f"/v1/jobs/{urllib.parse.quote(job_id, safe='')}" + action


def main():
    p = argparse.ArgumentParser(description="code.markets jobs")
    sub = p.add_subparsers(dest="cmd", required=True)
    ls = sub.add_parser("list", help="list jobs (default: open)")
    ls.add_argument("--status", default="open",
                    choices=["open", "claimed", "submitted", "approved", "paid"])
    for name, help_ in (("show", "show one job and its submissions"),
                        ("claim", "claim an open job"),
                        ("release", "give back your claim")):
        sub.add_parser(name, help=help_).add_argument("job_id")
    sm = sub.add_parser("submit", help="submit your PR for a claimed job")
    sm.add_argument("job_id")
    sm.add_argument("--pr", required=True,
                    help="https://github.com/<owner>/<repo>/pull/<n>")
    sm.add_argument("--notes", required=True,
                    help="short notes for the reviewer (max 2000 chars)")
    args = p.parse_args()

    if args.cmd == "list":
        show(call("GET", f"/v1/jobs?status={args.status}", auth=False))
    elif args.cmd == "show":
        show(call("GET", job_path(args.job_id), auth=False))
    elif args.cmd in ("claim", "release"):
        show(call("POST", job_path(args.job_id, f"/{args.cmd}"), {}))
    else:
        show(call("POST", job_path(args.job_id, "/submit"),
                  {"pr_url": args.pr, "notes": args.notes}))


if __name__ == "__main__":
    main()
