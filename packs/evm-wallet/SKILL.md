---
name: "evm-wallet"
description: "Create and operate a small EVM hot wallet (Base by default): generate a wallet, check ETH/ERC-20 balances, and send on-chain transfers with the user's approval. Use when the user wants their agent to hold crypto and do on-chain tasks."
---

# EVM Wallet

## Purpose
Give the agent its own small EVM hot wallet (Base default) that the user funds, so the agent can check balances and perform on-chain transfers with the user's explicit approval.

## Setup (once)
```bash
cd ~/workspace/skills/evm-wallet   # or wherever you placed this skill
bash bin/setup.sh                  # creates ~/.evm-wallet/.venv with eth-account
PY=~/.evm-wallet/.venv/bin/python
$PY bin/wallet.py new              # prints the wallet address; key saved to ~/.evm-wallet/key (0600)
```
Show the user the printed address so they can fund it. The wallet needs a little ETH for gas before it can send anything.

In the examples below, `PY=~/.evm-wallet/.venv/bin/python` and commands run from the skill directory.

## Tooling
- Show address: `$PY bin/wallet.py address`
- Balances (ETH + USDC on Base): `$PY bin/balance.py`
- Balances with other tokens: `$PY bin/balance.py --tokens 0xTokenAddress:6,0xOther:18`
- Prepare a transfer (dry run, never broadcasts): `$PY bin/send.py --to 0x... --amount 0.05 --token 0x... --decimals 6`
- Prepare an ETH transfer: `$PY bin/send.py --to 0x... --amount 0.001`
- Broadcast after user approval: add `--broadcast` (prints the tx hash)
- Use `--key-file PATH` (or `EVM_WALLET_KEY`) to use a different key file; `--chain-id` to target another EVM chain (default 8453 = Base).

Public RPCs throttle sandbox IPs, so `bin/rpc.py` rotates endpoints with retries. Always use these helpers instead of calling RPCs directly.

## Auth
- The private key lives only in `~/.evm-wallet/key` (mode 0600). The helpers never print it. Never write it to memory/notes, never paste it in chat, never commit it anywhere.

## Operating Rules
1. This is a HOT wallet in a regular VM, not a hardware wallet or secure enclave. Tell the user to fund only amounts they would be comfortable losing.
2. NEVER broadcast without the user's explicit approval in conversation. Workflow: run `send.py` WITHOUT `--broadcast`, show the user the full details (from, to, amount, token, estimated gas, total cost), and only re-run with `--broadcast` after they approve in chat.
3. On-chain transactions are irreversible and cost gas. Confirm the recipient address character-for-character and the network before broadcasting.
4. Verify token contract addresses from a confirmed transaction or a trusted source (CoinGecko, the project's official docs) — never from memory. Lookalike token addresses are a common scam.
5. After any broadcast, report the tx hash plus a block-explorer link, e.g. `https://basescan.org/tx/<hash>`.
