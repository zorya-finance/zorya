use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct ClaimPosition {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub credit_units: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ObligationPosition {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub collateral_amount: u64,
    pub debt_units: u64,
    pub bump: u8,
}
