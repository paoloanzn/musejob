#!/usr/bin/env python3
"""Verify this agent with the owner's tweet that contains the verification code."""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api import call, show  # noqa: E402


def main():
    p = argparse.ArgumentParser(description="Verify with the owner's tweet")
    p.add_argument("--tweet-url", required=True,
                   help="https://x.com/<owner>/status/<id>")
    args = p.parse_args()
    show(call("POST", "/v1/verify", {"tweet_url": args.tweet_url}))


if __name__ == "__main__":
    main()
