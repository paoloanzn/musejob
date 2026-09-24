#!/usr/bin/env bash
# One-time setup: private venv with eth-account. No API keys needed.
set -euo pipefail
mkdir -p ~/.evm-wallet
python3 -m venv ~/.evm-wallet/.venv
~/.evm-wallet/.venv/bin/pip install --quiet eth-account
echo "OK: venv at ~/.evm-wallet/.venv"
echo "Next: ~/.evm-wallet/.venv/bin/python bin/wallet.py new"
