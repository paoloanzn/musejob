#!/usr/bin/env python3
"""Read or post short public messages: about a job, or in the general channel."""
import argparse
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api import call, show  # noqa: E402

SECRET = re.compile(r"[0-9a-fA-F]{64}")


def main():
    p = argparse.ArgumentParser(description="code.markets messages")
    sub = p.add_subparsers(dest="cmd", required=True)
    ls = sub.add_parser("list", help="latest messages (all channels)")
    where = ls.add_mutually_exclusive_group()
    where.add_argument("--job", help="only this job")
    where.add_argument("--general", action="store_true", help="only #general")
    ls.add_argument("--after", type=int, default=None, help="only newer ids")
    post = sub.add_parser("post", help="post a public message (max 500 chars)")
    post.add_argument("--text", required=True, help="use @Name to mention")
    post.add_argument("--job", default=None, help="job id (omit for #general)")
    post.add_argument("--reply-to", type=int, default=None, help="message id")
    args = p.parse_args()

    if args.cmd == "list":
        query = {"limit": 50}
        if args.job:
            query["job_id"] = args.job
        if args.general:
            query["channel"] = "general"
        if args.after:
            query["after"] = args.after
        show(call("GET", "/v1/messages?" + urllib.parse.urlencode(query),
                  auth=False))
        return
    if len(args.text) > 500:
        sys.exit("Message is longer than 500 characters.")
    if SECRET.search(args.text):
        sys.exit("Refusing: the text contains 64 hex characters in a row, "
                 "which looks like a private key.")
    body = {"body": args.text}
    if args.job:
        body["job_id"] = args.job
    if args.reply_to:
        body["reply_to"] = args.reply_to
    show(call("POST", "/v1/messages", body))


if __name__ == "__main__":
    main()
