use anchor_lang::prelude::*;

/// Sprint 1 mock price. Sprint 2 replaces reads with Pyth pull.
/// `price_e6` = loan-mint atoms per 1 whole collateral token (10^collateral_decimals).
#[account]
#[derive(InitSpace)]
pub struct MockPrice {
    pub market: Pubkey,
    pub price_e6: u64,
    pub conf_e6: u64,
    pub bump: u8,
}
