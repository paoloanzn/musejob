"""Resilient public-RPC client.

Public RPCs throttle/block datacenter IPs intermittently, so every call
rotates through several endpoints with retries and backoff. No API keys.
"""
import json
import time
import urllib.request

ENDPOINTS = [
    "https://developer-access-mainnet.base.org",
    "https://base-rpc.publicnode.com",
    "https://mainnet.base.org",
    "https://base.llamarpc.com",
    "https://base.meowrpc.com",
    "https://1rpc.io/base",
    "https://base-mainnet.public.blastapi.io",
]

TIMEOUT = 15
MAX_ROUNDS = 3
RETRY_DELAY = 2


def rpc_call(method, params, label="call"):
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                          "params": params}).encode()
    last_err = None
    for _ in range(MAX_ROUNDS):
        for url in ENDPOINTS:
            try:
                req = urllib.request.Request(
                    url, data=payload,
                    headers={"Content-Type": "application/json",
                             "User-Agent": "Mozilla/5.0"})
                body = urllib.request.urlopen(req, timeout=TIMEOUT).read()
                resp = json.loads(body)
                if resp.get("result") is not None:
                    return resp["result"]
                last_err = f"null result: {str(resp.get('error'))[:80]}"
            except Exception as e:
                last_err = f"{type(e).__name__}: {str(e)[:80]}"
            time.sleep(0.5)
        time.sleep(RETRY_DELAY)
    raise RuntimeError(f"{label} failed after retries ({last_err})")
