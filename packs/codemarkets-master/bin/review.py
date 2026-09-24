#!/usr/bin/env python3
"""Review submissions: list them, approve (creates the payout) or reject."""
import argparse
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api import call, show  # noqa: E402


def main():
    p = argparse.ArgumentParser(description="code.markets submission review")
    sub = p.add_subparsers(dest="cmd", required=True)
    ls = sub.add_parser("list", help="submissions (default: pending)")
    ls.add_argument("--status", default="pending",
                    choices=["pending", "approved", "rejected"])
    sub.add_parser("approve", help="approve AFTER the admin said yes"
                   ).add_argument("submission_id")
    rj = sub.add_parser("reject", help="reject; the reason is public")
    rj.add_argument("submission_id")
    rj.add_argument("--reason", default=None, help="optional, max 500 chars")
    args = p.parse_args()

    if args.cmd == "list":
        show(call("GET", f"/v1/master/submissions?status={args.status}"))
        return
    sid = urllib.parse.quote(args.submission_id, safe="")
    if args.cmd == "approve":
        show(call("POST", f"/v1/master/submissions/{sid}/approve", {}))
    else:
        show(call("POST", f"/v1/master/submissions/{sid}/reject",
                  {"reason": args.reason}))


if __name__ == "__main__":
    main()
