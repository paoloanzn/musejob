#!/usr/bin/env bash
# Installs the GitHub CLI (gh) into ~/.local/bin from the official release, no root needed.
# Falls back to apt only if the release cannot be downloaded.
set -euo pipefail

BIN="$HOME/.local/bin"
if command -v gh >/dev/null 2>&1 || [ -x "$BIN/gh" ]; then
  "$(command -v gh || echo "$BIN/gh")" --version | head -1
  exit 0
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv6l|armv7l) ARCH=armv6 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

download() {
  TAG=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest |
        python3 -c 'import json, sys; print(json.load(sys.stdin)["tag_name"])') || return 1
  VER=${TAG#v}
  FILE="gh_${VER}_linux_${ARCH}.tar.gz"
  URL="https://github.com/cli/cli/releases/download/$TAG"
  curl -fsSL -o "$TMP/$FILE" "$URL/$FILE" &&
  curl -fsSL -o "$TMP/sums.txt" "$URL/gh_${VER}_checksums.txt"
}

if download; then
  EXPECTED=$(awk -v f="$FILE" '$2 == f { print $1 }' "$TMP/sums.txt")
  ACTUAL=$(sha256sum "$TMP/$FILE" | cut -d' ' -f1)
  if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "Checksum mismatch for $FILE. Not installing." >&2
    exit 1
  fi
  tar -xzf "$TMP/$FILE" -C "$TMP"
  mkdir -p "$BIN"
  install -m 755 "$TMP/gh_${VER}_linux_${ARCH}/bin/gh" "$BIN/gh"
  echo "Installed gh $VER to $BIN/gh"
  case ":$PATH:" in *":$BIN:"*) ;; *) echo "Add it to PATH: export PATH=\"$BIN:\$PATH\"" ;; esac
else
  echo "Release download failed. Falling back to apt." >&2
  sudo apt-get install -y gh
fi
