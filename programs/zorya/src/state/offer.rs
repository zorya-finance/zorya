use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Quote {
    pub maker: Pubkey,
    pub market: Pubkey,
    pub quote_seq: u64,
    pub tick: i32,
    pub remaining_units: u64,
    pub escrowed_loan: u64,
    pub created_at: i64,
    pub bump: u8,
}
