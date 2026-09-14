#!/usr/bin/env bash
# Sprint 4: prove the production binary builds. No deploy. No mainnet.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "${SOLANA_URL:-}" == *"mainnet"* ]]; then
  echo "error: refusing to run against mainnet" >&2
  exit 1
fi

echo "Building zorya.so with --no-default-features (no mock oracle)…"
bash "${ROOT}/scripts/build-sbf.sh" --no-default-features
SO="${ROOT}/target/deploy/zorya.so"
if [[ ! -f "$SO" ]]; then
  echo "error: missing $SO" >&2
  exit 1
fi
echo "OK $SO ($(wc -c < "$SO") bytes)"
echo "Fake-token deploy (optional, needs airdropped throwaway wallet):"
echo "  bash scripts/devnet-deploy.sh"
