#!/usr/bin/env python3
"""Store the master API key given by the admin. Reads it from stdin, never prints it."""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api import KEY_FILE, call, save_key  # noqa: E402


def main():
    key = sys.stdin.readline().strip()
    if not re.fullmatch(r"cmk_[0-9a-f]{64}", key):
        sys.exit("That does not look like a code.markets API key (cmk_...).")
    save_key(key)
    call("GET", "/v1/master/payouts")
    print(f"Master key saved to {KEY_FILE} (mode 600) and accepted by the API.")


if __name__ == "__main__":
    main()
