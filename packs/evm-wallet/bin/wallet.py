#!/usr/bin/env python3
"""Create or inspect the agent's EVM hot wallet.

The private key is stored in a 0600 file and NEVER printed.
"""
import argparse
import os
import stat
import sys

from eth_account import Account


def key_path(args):
    return os.path.expanduser(
        args.key_file or os.environ.get("EVM_WALLET_KEY", "~/.evm-wallet/key"))


def cmd_new(args):
    path = key_path(args)
    if os.path.exists(path) and not args.force:
        print(f"Key file already exists: {path} (use --force to overwrite)",
              file=sys.stderr)
        sys.exit(1)
    acct = Account.create()  # cryptographically secure (os.urandom)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(acct.key.hex())
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    # Sanity: re-derive to prove the stored key matches the address.
    check = Account.from_key(open(path).read().strip()).address
    assert check == acct.address, "key/address mismatch!"
    print(f"Wallet created. Fund this address:\n{acct.address}")
    print(f"Key stored at {path} (mode 600, never shown).", file=sys.stderr)


def cmd_address(args):
    path = key_path(args)
    if not os.path.exists(path):
        print(f"No wallet yet at {path}; run 'wallet.py new' first.",
              file=sys.stderr)
        sys.exit(1)
    print(Account.from_key(open(path).read().strip()).address)


def main():
    p = argparse.ArgumentParser(description="Agent EVM hot wallet")
    p.add_argument("--key-file", default=None,
                   help="override key file location")
    sub = p.add_subparsers(dest="cmd", required=True)
    # Repeat --key-file on each subcommand so it works in any position.
    for name, help_ in (("new", "generate a new wallet"),
                        ("address", "print the wallet address")):
        s = sub.add_parser(name, help=help_)
        s.add_argument("--key-file", default=None,
                       help="override key file location")
    n = sub.choices["new"]
    n.add_argument("--force", action="store_true",
                   help="overwrite an existing key file")
    args = p.parse_args()
    if args.cmd == "new":
        cmd_new(args)
    else:
        cmd_address(args)


if __name__ == "__main__":
    main()
