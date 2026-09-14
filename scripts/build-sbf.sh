#!/usr/bin/env bash
# cargo-build-sbf 2.1 ships rustc 1.79, which cannot parse current crates.io
# manifests. Build with platform-tools v1.53 (rustc 1.89) instead.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="${HOME}/.cache/solana/v1.53/platform-tools"
if [[ ! -x "${TOOLS}/rust/bin/rustc" ]]; then
  echo "platform-tools v1.53 not found. Install Solana 2.1+ then:"
  echo "  cargo-build-sbf --tools-version v1.53 --install-only"
  exit 1
fi
export PATH="${TOOLS}/rust/bin:${TOOLS}/llvm/bin:${ROOT}/.tools/bin:${PATH}"
export RUSTC="${TOOLS}/rust/bin/rustc"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${ROOT}/target}"
cargo build --release --target sbpf-solana-solana --manifest-path "${ROOT}/programs/zorya/Cargo.toml" "$@"
mkdir -p "${ROOT}/target/deploy" "${ROOT}/target/idl" "${ROOT}/target/types"
cp -f "${CARGO_TARGET_DIR}/sbpf-solana-solana/release/zorya.so" "${ROOT}/target/deploy/zorya.so"
unset RUSTC
# Anchor IDL build needs rustup's cargo (`+nightly`), not the SBF cargo.
export PATH="${HOME}/.cargo/bin:${ROOT}/.tools/bin:${PATH}"
if [[ -x "${ROOT}/.tools/bin/anchor" ]]; then
  "${ROOT}/.tools/bin/anchor" idl build -o "${ROOT}/target/idl/zorya.json"
  "${ROOT}/.tools/bin/anchor" idl type "${ROOT}/target/idl/zorya.json" --out "${ROOT}/target/types/zorya.ts"
fi
echo "OK ${ROOT}/target/deploy/zorya.so"
