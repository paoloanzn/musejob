#!/usr/bin/env python3
"""Send ETH or an ERC-20 token from the agent's wallet.

DEFAULT IS DRY RUN: prints full transaction details and exits WITHOUT
broadcasting. Add --broadcast only after the user explicitly approved the
exact details shown by the dry run.
"""
import argparse
import os
import sys
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rpc import rpc_call  # noqa: E402
from eth_account import Account  # noqa: E402

BASE_CHAIN_ID = 8453


def key_path(args):
    return os.path.expanduser(
        args.key_file or os.environ.get("EVM_WALLET_KEY", "~/.evm-wallet/key"))


def to_base_units(amount_str, decimals):
    return int(Decimal(amount_str) * (10 ** decimals))


def main():
    p = argparse.ArgumentParser(description="Send ETH/ERC-20 (dry run by default)")
    p.add_argument("--to", required=True, help="recipient address")
    p.add_argument("--amount", required=True,
                   help="human-readable amount, e.g. 0.05")
    p.add_argument("--token", default=None, help="ERC-20 contract address")
    p.add_argument("--decimals", type=int, default=18,
                   help="token decimals (default 18; USDC=6)")
    p.add_argument("--key-file", default=None)
    p.add_argument("--chain-id", type=int, default=BASE_CHAIN_ID)
    p.add_argument("--broadcast", action="store_true",
                   help="actually sign and broadcast (needs user approval!)")
    args = p.parse_args()

    if not args.to.startswith("0x") or len(args.to) != 42:
        sys.exit(f"bad recipient address: {args.to}")
    if args.token and (len(args.token) != 42 or not args.token.startswith("0x")):
        sys.exit(f"bad token address: {args.token}")

    path = key_path(args)
    if not os.path.exists(path):
        sys.exit(f"No wallet at {path}; run 'wallet.py new' first.")
    acct = Account.from_key(open(path).read().strip())
    sender = acct.address

    amount_units = to_base_units(args.amount, args.decimals if args.token else 18)

    if args.token:
        # transfer(address,uint256)
        data = ("0xa9059cbb"
                + args.to[2:].lower().rjust(64, "0")
                + format(amount_units, "064x"))
        tx = {"from": sender, "to": args.token, "data": data, "value": "0x0"}
        what = f"{args.amount} tokens ({args.token})"
    else:
        tx = {"from": sender, "to": args.to,
              "value": hex(amount_units)}
        what = f"{args.amount} ETH"

    def as_int(v):
        return int(v, 16) if isinstance(v, str) else int(v)

    tx["nonce"] = as_int(rpc_call("eth_getTransactionCount",
                                 [sender, "pending"], "nonce"))
    gas_price = as_int(rpc_call("eth_gasPrice", [], "gasPrice"))
    tx["gasPrice"] = hex(gas_price)
    try:
        gas_limit = as_int(rpc_call("eth_estimateGas", [tx], "estimateGas"))
    except Exception as e:
        # Estimation can fail (e.g. tx would revert); fall back to a
        # conservative limit rather than crashing the dry run.
        gas_limit = 21000 if not args.token else 100000
        print(f"note: gas estimation unavailable ({e}); "
              f"using fallback limit {gas_limit}", file=sys.stderr)
    tx["gas"] = hex(gas_limit)
    tx["chainId"] = args.chain_id

    gas_cost = gas_limit * gas_price
    eth_bal = int(rpc_call("eth_getBalance", [sender, "latest"],
                           "eth_getBalance"), 16)
    need_eth = gas_cost + (amount_units if not args.token else 0)

    print("=== TRANSACTION ===")
    print(f"from:    {sender}")
    print(f"to:      {args.to}")
    print(f"sends:   {what}")
    print(f"chain:   {args.chain_id}")
    print(f"nonce:   {tx['nonce']}")
    print(f"gas:     {gas_limit} @ {gas_price / 1e9:.3f} gwei "
          f"= {gas_cost / 1e18:.8f} ETH")
    print(f"balance: {eth_bal / 1e18:.8f} ETH")
    if eth_bal < need_eth:
        sys.exit(f"ABORT: insufficient ETH (need {need_eth / 1e18:.8f}, "
                 f"have {eth_bal / 1e18:.8f})")
    if not args.broadcast:
        print("DRY RUN — nothing broadcast. Re-run with --broadcast "
              "after the user approves these exact details.")
        return

    signed = acct.sign_transaction(tx)
    tx_hash = rpc_call("eth_sendRawTransaction",
                       [signed.raw_transaction.hex()], "sendRawTransaction")
    print(f"BROADCAST OK: {tx_hash}")
    print(f"https://basescan.org/tx/{tx_hash}")


if __name__ == "__main__":
    main()
