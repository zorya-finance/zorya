#!/usr/bin/env bash
# Deploy the no-mock binary to Solana devnet. Fake tokens only — no real TVL.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${HOME}/.local/share/solana/install/active_release/bin:${ROOT}/.tools/bin:${PATH}"

PROGRAM_ID="8U8gwf1R6VNX6GwbzNwnXbrBnTnR4M98aGQBzoJVTm17"
WALLET="${ROOT}/.keys/id.json"
KEYPAIR="${ROOT}/.keys/program.json"
if [[ ! -f "${KEYPAIR}" ]]; then
  KEYPAIR="${ROOT}/target/deploy/zorya-keypair.json"
fi

if [[ ! -f "${WALLET}" ]]; then
  echo "Missing ${WALLET}. Create a throwaway wallet, airdrop SOL, never use mainnet keys."
  exit 1
fi
if [[ ! -f "${KEYPAIR}" ]]; then
  echo "Missing program keypair for ${PROGRAM_ID}."
  echo "Put it at .keys/program.json (gitignored) or target/deploy/zorya-keypair.json."
  echo "If you lost it, generate a new one and update declare_id + Anchor.toml."
  exit 1
fi

solana config set --url https://api.devnet.solana.com --keypair "${WALLET}" >/dev/null
BAL="$(solana balance --lamports | awk '{print $1}')"
if [[ "${BAL}" -lt 2000000000 ]]; then
  echo "Airdropping 2 SOL on devnet…"
  solana airdrop 2
fi

echo "Building --no-default-features (no set_mock_price, 30-day min maturity)…"
bash "${ROOT}/scripts/build-sbf.sh" --no-default-features

echo "Deploying ${PROGRAM_ID}…"
solana program deploy \
  "${ROOT}/target/deploy/zorya.so" \
  --program-id "${KEYPAIR}" \
  --upgrade-authority "${WALLET}"

echo "OK. Next:"
echo "  1. initialize_config"
echo "  2. create fake wSOL/USDC mints (do not use mainnet mints)"
echo "  3. create_market with SOL/USD feed 0xef0d8b6f…b56d"
echo "  4. Post a Hermes PriceUpdateV2 in the same tx as fill / withdraw / liquidate"
echo "     Receiver: rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"
echo "     Hermes: https://pyth.dourolabs.app/hermes  (or hermes.pyth.network + API key)"
echo "     npm: @pythnetwork/hermes-client + @pythnetwork/pyth-solana-receiver"
