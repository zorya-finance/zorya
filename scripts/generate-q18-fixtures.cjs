// Regenerate the committed local-validator fixtures after generating the IDL.
// Synthetic genesis state: tests Q18 after settlement, not state reachability.
const fs = require("fs");
const path = require("path");
const anchor = require("@coral-xyz/anchor");
const { AccountLayout, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const { PublicKey } = anchor.web3;

(async () => {
  const root = path.resolve(__dirname, "..");
  // Public, deterministic local-test signer. Never use it for real funds.
  const owner = anchor.web3.Keypair.fromSeed(Buffer.alloc(32, 81));
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection("http://127.0.0.1:8899"),
    new anchor.Wallet(owner),
    {},
  );
  const program = new anchor.Program(
    JSON.parse(
      fs.readFileSync(path.join(root, "target/idl/zorya.json"), "utf8"),
    ),
    provider,
  );
  const out = path.join(root, "tests/fixtures/settled-cash-short");
  fs.mkdirSync(out, { recursive: true });
  const collateralMint = new PublicKey(Buffer.alloc(32, 51));
  const loanMint = new PublicKey(Buffer.alloc(32, 52));
  const ownerLoan = new PublicKey(Buffer.alloc(32, 53));
  const maturity = new anchor.BN(1);
  const le = (n, width) => new anchor.BN(n).toArrayLike(Buffer, "le", width);
  const pda = (...seeds) =>
    PublicKey.findProgramAddressSync(seeds, program.programId);
  const [market, bump] = pda(
    Buffer.from("market"),
    collateralMint.toBuffer(),
    loanMint.toBuffer(),
    le(maturity, 8),
    le(7000, 2),
  );
  const [loanVault, loanVaultBump] = pda(
    Buffer.from("loan-vault"),
    market.toBuffer(),
  );
  const [, collateralVaultBump] = pda(
    Buffer.from("collateral-vault"),
    market.toBuffer(),
  );
  const [claim, claimBump] = pda(
    Buffer.from("claim"),
    market.toBuffer(),
    provider.publicKey.toBuffer(),
  );
  const save = (key, owner, data) => {
    fs.writeFileSync(
      path.join(out, `${key}.json`),
      JSON.stringify(
        {
          pubkey: key.toBase58(),
          account: {
            lamports: 10_000_000,
            data: [data.toString("base64"), "base64"],
            owner: owner.toBase58(),
            executable: false,
            rentEpoch: 0,
          },
        },
        null,
        2,
      ) + "\n",
    );
  };
  save(
    market,
    program.programId,
    await program.coder.accounts.encode("termMarket", {
      collateralMint,
      loanMint,
      oracleProgram: PublicKey.default,
      oracleFeedId: Array(32).fill(0),
      lltvBps: 7000,
      liquidationCursorBps: 3000,
      maturityTs: maturity,
      tickDeltaBps: 200,
      minFillUnits: new anchor.BN(1_000_000),
      status: { matured: {} },
      totalCreditUnits: new anchor.BN(100_000_000),
      totalDebtUnits: new anchor.BN(0),
      lossFactorWad: new anchor.BN("500000000000000000"),
      settlementFeeBps: 0,
      oracleKind: 0,
      collateralDecimals: 9,
      loanDecimals: 6,
      loanVaultBump,
      collateralVaultBump,
      bump,
    }),
  );
  save(
    claim,
    program.programId,
    await program.coder.accounts.encode("claimPosition", {
      owner: provider.publicKey,
      market,
      creditUnits: new anchor.BN(100_000_000),
      bump: claimBump,
    }),
  );
  const token = (owner, amount) => {
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode(
      {
        mint: loanMint,
        owner,
        amount,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      data,
    );
    return data;
  };
  save(loanVault, TOKEN_PROGRAM_ID, token(market, 20_000_000n));
  save(ownerLoan, TOKEN_PROGRAM_ID, token(provider.publicKey, 0n));
  fs.writeFileSync(
    path.join(out, "manifest.json"),
    JSON.stringify(
      {
        market: market.toBase58(),
        claim: claim.toBase58(),
        loanVault: loanVault.toBase58(),
        ownerLoan: ownerLoan.toBase58(),
        synthetic: true,
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Prepared four synthetic Q18 genesis accounts");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
