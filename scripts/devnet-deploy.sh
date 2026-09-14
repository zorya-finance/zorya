#!/usr/bin/env bash
# Deploy the no-mock binary to Solana **devnet**. Fake tokens only. No TVL. No mainnet.
# Never mutates ~/.config/solana (this machine's CLI default is mainnet).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${HOME}/.local/share/solana/install/active_release/bin:${ROOT}/.tools/bin:${PATH}"

PROGRAM_ID="8U8gwf1R6VNX6GwbzNwnXbrBnTnR4M98aGQBzoJVTm17"
WALLET="${ROOT}/.keys/id.json"
KEYPAIR="${ROOT}/.keys/program.json"
URL="${SOLANA_URL:-https://api.devnet.solana.com}"
if [[ ! -f "${KEYPAIR}" ]]; then
  KEYPAIR="${ROOT}/target/deploy/zorya-keypair.json"
fi

if [[ "${URL}" == *"mainnet"* ]]; then
  echo "error: refusing to run against mainnet" >&2
  exit 1
fi
if [[ ! -f "${WALLET}" ]]; then
  echo "Missing ${WALLET}. Create a throwaway wallet, airdrop SOL, never use mainnet keys." >&2
  exit 1
fi
if [[ ! -f "${KEYPAIR}" ]]; then
  echo "Missing program keypair for ${PROGRAM_ID}." >&2
  exit 1
fi

PUB="$(solana-keygen pubkey "${WALLET}")"
echo "Wallet ${PUB}"
echo "RPC    ${URL}"

need_lamports=12000000000
for i in 1 2 3 4 5 6 7 8; do
  bal="$(solana balance --lamports --keypair "${WALLET}" -u "${URL}" | awk '{print $1}')"
  echo "Balance ${bal} lamports"
  if [[ "${bal}" -ge "${need_lamports}" ]]; then
    break
  fi
  echo "Airdropping 2 SOL (attempt ${i})…"
  solana airdrop 2 "${PUB}" --keypair "${WALLET}" -u "${URL}" || sleep 3
  sleep 2
done
bal="$(solana balance --lamports --keypair "${WALLET}" -u "${URL}" | awk '{print $1}')"
if [[ "${bal}" -lt 6000000000 ]]; then
  echo "error: need at least ~6 SOL on devnet to deploy (have ${bal} lamports)." >&2
  echo "  Peak rent is ~2× program size (${PROGRAM_ID} ≈ 3.81 SOL). Get Devnet SOL at https://faucet.solana.com for ${PUB}." >&2
  echo "  Do not fund this throwaway wallet on mainnet." >&2
  exit 1
fi

echo "Building zorya.so with --no-default-features (no mock oracle, 30-day min maturity)…"
bash "${ROOT}/scripts/build-sbf.sh" --no-default-features

echo "Deploying ${PROGRAM_ID} to devnet…"
solana program deploy \
  "${ROOT}/target/deploy/zorya.so" \
  --program-id "${KEYPAIR}" \
  --upgrade-authority "${WALLET}" \
  --keypair "${WALLET}" \
  -u "${URL}"

echo "OK. Smoke with fake mints + Pyth pull:"
echo "  npm run devnet:smoke"
echo "Then rebuild the localnet mock binary:"
echo "  npm run build:sbf"
