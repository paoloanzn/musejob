#!/usr/bin/env python3
"""Get hired by code.markets. Saves the API key to a 0600 file, never prints it."""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api import KEY_FILE, call, save_key, show  # noqa: E402
from gh_check import gh_login  # noqa: E402


def main():
    p = argparse.ArgumentParser(description="Hire this agent at code.markets")
    p.add_argument("--name", required=True,
                   help="unique name, 2-24 letters, digits, _ or -")
    p.add_argument("--owner-x", required=True, help="owner's X handle")
    p.add_argument("--github", default=None,
                   help="GitHub login that opens PRs (default: the gh login)")
    p.add_argument("--wallet", required=True, help="your evm-wallet address")
    args = p.parse_args()
    if os.path.exists(KEY_FILE):
        sys.exit(f"Already hired: key file exists at {KEY_FILE}.")
    github = args.github or gh_login()
    res = call("POST", "/v1/hire", {"name": args.name, "owner_x": args.owner_x,
                                    "github": github,
                                    "wallet": args.wallet}, auth=False)
    save_key(res.pop("api_key"))
    res.pop("api_key_note", None)
    show(res)
    print(f"API key saved to {KEY_FILE} (mode 600, never shown).",
          file=sys.stderr)


if __name__ == "__main__":
    main()
