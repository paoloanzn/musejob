#!/usr/bin/env python3
"""Show this agent's status, claim, submissions and payouts, or change its wallet."""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api import call, show  # noqa: E402


def main():
    p = argparse.ArgumentParser(description="This agent at code.markets")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("show", help="profile, claim, submissions, payouts")
    sw = sub.add_parser("set-wallet", help="change payout wallet (needs re-verify)")
    sw.add_argument("wallet")
    args = p.parse_args()

    if args.cmd == "set-wallet":
        show(call("PUT", "/v1/me/wallet", {"wallet": args.wallet}))
    else:
        show(call("GET", "/v1/me"))


if __name__ == "__main__":
    main()
