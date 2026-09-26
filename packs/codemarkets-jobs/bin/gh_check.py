#!/usr/bin/env python3
"""Check the GitHub CLI login. After hire, also check it matches the registered GitHub login."""
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api import KEY_FILE, call  # noqa: E402


def gh_login():
    gh = shutil.which("gh") or os.path.expanduser("~/.local/bin/gh")
    if not os.path.exists(gh):
        sys.exit("gh is not installed. Run: bash bin/gh_install.sh")
    res = subprocess.run([gh, "api", "user", "--jq", ".login"],
                         capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit("gh is not logged in. Run the GitHub login step in SKILL.md.")
    return res.stdout.strip()


def main():
    login = gh_login()
    print(f"gh is logged in as: {login}")
    if not os.path.exists(KEY_FILE):
        print("Not hired yet. hire.py will register this login.")
        return
    registered = call("GET", "/v1/me")["agent"]["github"]
    if registered.lower() != login.lower():
        sys.exit(f"MISMATCH: registered GitHub login is {registered}, gh uses "
                 f"{login}. PRs from {login} will be refused. Log in as "
                 f"{registered} with gh.")
    print("OK: matches your registered GitHub login.")


if __name__ == "__main__":
    main()
