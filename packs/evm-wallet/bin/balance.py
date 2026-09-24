#!/usr/bin/env python3
"""Show wallet balances: native ETH plus any ERC-20 tokens (read-only)."""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rpc import rpc_call  # noqa: E402
from eth_account import Account  # noqa: E402

# token_address:decimals pairs, e.g. "0xabc...:6"
DEFAULT_TOKENS = [
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913:6",  # USDC on Base
]


def key_path(args):
    return os.path.expanduser(
        args.key_file or os.environ.get("EVM_WALLET_KEY", "~/.evm-wallet/key"))


def erc20_balance(token, wallet, decimals):
    data = "0x70a08231" + wallet[2:].lower().rjust(64, "0")
    raw = rpc_call("eth_call", [{"to": token, "data": data}, "latest"],
                   f"balanceOf {token}")
    return int(raw, 16) / (10 ** decimals)


def main():
    p = argparse.ArgumentParser(description="Wallet balances (read-only)")
    p.add_argument("--key-file", default=None)
    p.add_argument("--tokens", default=",".join(DEFAULT_TOKENS),
                   help="comma-separated token:decimals list; empty to skip")
    args = p.parse_args()
    path = key_path(args)
    if not os.path.exists(path):
        print(f"No wallet at {path}; run 'wallet.py new' first.", file=sys.stderr)
        sys.exit(1)
    wallet = Account.from_key(open(path).read().strip()).address
    print(f"address: {wallet}")
    eth = int(rpc_call("eth_getBalance", [wallet, "latest"],
                       "eth_getBalance"), 16)
    print(f"ETH:  {eth / 1e18}")
    for spec in filter(None, args.tokens.split(",")):
        token, dec = spec.rsplit(":", 1)
        try:
            bal = erc20_balance(token.strip(), wallet, int(dec))
            print(f"{token.strip()}: {bal}")
        except Exception as e:
            print(f"{token.strip()}: ERROR {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
