#!/usr/bin/env python3
"""List payouts to send, and report the tx hash once a payout is sent."""
import argparse
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api import call, show  # noqa: E402


def send_command(payout, usdc_address):
    """Dry-run command for the evm-wallet skill, built only from ledger fields."""
    to, amount = payout["to_address"], payout["amount_usdc"]
    if not re.fullmatch(r"0x[0-9a-f]{40}", to) or \
            not re.fullmatch(r"\d+\.\d{2}", amount):
        sys.exit(f"Refusing payout {payout['id']}: malformed address or amount.")
    return (f"$PY bin/send.py --to {to} --amount {amount} "
            f"--token {usdc_address} --decimals 6")


def main():
    p = argparse.ArgumentParser(description="code.markets payouts")
    sub = p.add_subparsers(dest="cmd", required=True)
    ls = sub.add_parser("list", help="payouts (default: pending)")
    ls.add_argument("--status", default="pending", choices=["pending", "paid"])
    rp = sub.add_parser("report", help="report the tx hash of a sent payout")
    rp.add_argument("payout_id")
    rp.add_argument("--tx", required=True, help="0x... transaction hash")
    args = p.parse_args()

    if args.cmd == "report":
        pid = urllib.parse.quote(args.payout_id, safe="")
        show(call("POST", f"/v1/master/payouts/{pid}/tx", {"tx_hash": args.tx}))
        return
    res = call("GET", f"/v1/master/payouts?status={args.status}")
    show(res)
    if args.status == "pending":
        for payout in res["payouts"]:
            print(f"\n{payout['id']}: {payout['amount_usdc']} USDC to "
                  f"{payout['to_address']}")
            print("  dry run (from the evm-wallet skill directory):")
            print("  " + send_command(payout, res["usdc_address"]))


if __name__ == "__main__":
    main()
