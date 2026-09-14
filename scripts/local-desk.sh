#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
SOLANA_BIN="${SOLANA_BIN:-$HOME/.local/share/solana/install/active_release/bin}"
if [[ -d "$SOLANA_BIN" ]]; then
  export PATH="$SOLANA_BIN:$PATH"
fi
if [[ -x "$ROOT/.tools/bin/anchor" ]]; then
  export PATH="$ROOT/.tools/bin:$PATH"
fi

if ! command -v solana-test-validator >/dev/null 2>&1; then
  echo "Solana CLI not found. Add this to your shell, then reopen the terminal:"
  echo "  export PATH=\"\$HOME/.local/share/solana/install/active_release/bin:\$PATH\""
  exit 1
fi

if ! solana cluster-version -u localhost >/dev/null 2>&1; then
  echo "Start the validator in another terminal:"
  echo "  export PATH=\"\$HOME/.local/share/solana/install/active_release/bin:\$PATH\""
  echo "  solana-test-validator --reset"
  exit 1
fi

export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$ROOT/.keys/id.json}"

npm run build:sbf
solana airdrop 20 "$(solana-keygen pubkey "$ANCHOR_WALLET")" -u localhost >/dev/null
anchor deploy --provider.cluster localnet
npx ts-node --transpile-only --compiler-options '{"esModuleInterop":true,"resolveJsonModule":true}' scripts/seed-local-desk.ts
echo "Dashboard: connect the Local wallet on http://localhost:3000/dashboard"
