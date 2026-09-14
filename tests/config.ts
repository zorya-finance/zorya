import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { SystemProgram } from "@solana/web3.js";
import { Zorya } from "../target/types/zorya";
import { ensureConfig, pda, setPaused } from "./helpers";

describe("config", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as Program<Zorya>;

  it("initialize_config once and rejects a second init", async () => {
    const config = await ensureConfig(program);
    const account = await program.account.protocolConfig.fetch(config);
    expect(account.authority.toBase58()).to.equal(
      provider.publicKey.toBase58(),
    );
    expect(account.paused).to.equal(false);
    expect(account.lltvCount).to.equal(2);
    expect(account.allowedLltvBps[0]).to.equal(7000);
    expect(account.allowedLltvBps[1]).to.equal(6500);

    try {
      await program.methods
        .initializeConfig()
        .accountsPartial({
          authority: provider.publicKey,
          config,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("second init should fail");
    } catch (err) {
      expect(String(err)).to.match(/already in use|already been initialized/i);
    }
  });

  it("set_paused is authority-only", async () => {
    await setPaused(program, true);
    const config = pda(program.programId).config();
    expect((await program.account.protocolConfig.fetch(config)).paused).to.equal(
      true,
    );
    await setPaused(program, false);
    expect((await program.account.protocolConfig.fetch(config)).paused).to.equal(
      false,
    );
  });
});
