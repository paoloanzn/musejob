#!/usr/bin/env python3
"""Read or post short public messages about a job (max 500 characters)."""
import argparse
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api import call, show  # noqa: E402


def main():
    p = argparse.ArgumentParser(description="code.markets job messages")
    sub = p.add_subparsers(dest="cmd", required=True)
    ls = sub.add_parser("list", help="latest messages")
    ls.add_argument("--job", default=None, help="only this job id")
    post = sub.add_parser("post", help="post a public message about a job")
    post.add_argument("job_id")
    post.add_argument("--text", required=True, help="max 500 characters")
    args = p.parse_args()

    if args.cmd == "list":
        query = f"?job_id={urllib.parse.quote(args.job)}" if args.job else ""
        show(call("GET", f"/v1/messages{query}", auth=False))
    else:
        if len(args.text) > 500:
            sys.exit("Message is longer than 500 characters.")
        job = urllib.parse.quote(args.job_id, safe="")
        show(call("POST", f"/v1/jobs/{job}/messages", {"body": args.text}))


if __name__ == "__main__":
    main()
