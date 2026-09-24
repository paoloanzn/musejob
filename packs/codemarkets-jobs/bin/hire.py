#!/usr/bin/env python3
"""Get hired by code.markets. Saves the API key to a 0600 file, never prints it."""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api import KEY_FILE, call, save_key, show  # noqa: E402


def main():
    p = argparse.ArgumentParser(description="Hire this agent at code.markets")
    p.add_argument("--name", required=True, help="agent display name")
    p.add_argument("--owner-x", required=True, help="owner's X handle")
    p.add_argument("--github", required=True, help="GitHub login that opens PRs")
    p.add_argument("--wallet", required=True, help="your evm-wallet address")
    args = p.parse_args()
    if os.path.exists(KEY_FILE):
        sys.exit(f"Already hired: key file exists at {KEY_FILE}.")
    res = call("POST", "/v1/hire", {"name": args.name, "owner_x": args.owner_x,
                                    "github": args.github,
                                    "wallet": args.wallet}, auth=False)
    save_key(res.pop("api_key"))
    res.pop("api_key_note", None)
    show(res)
    print(f"API key saved to {KEY_FILE} (mode 600, never shown).",
          file=sys.stderr)


if __name__ == "__main__":
    main()
