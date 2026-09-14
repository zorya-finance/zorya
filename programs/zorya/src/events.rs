use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub authority: Pubkey,
}

#[event]
pub struct PauseUpdated {
    pub paused: bool,
}

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub collateral_mint: Pubkey,
    pub loan_mint: Pubkey,
    pub maturity_ts: i64,
    pub lltv_bps: u16,
}

#[event]
pub struct CollateralDeposited {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct CollateralWithdrawn {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct QuoteCreated {
    pub quote: Pubkey,
    pub market: Pubkey,
    pub maker: Pubkey,
    pub tick: i32,
    pub units: u64,
    pub escrowed_loan: u64,
}

#[event]
pub struct QuoteCancelled {
    pub quote: Pubkey,
    pub maker: Pubkey,
    pub returned_loan: u64,
}

#[event]
pub struct QuoteFilled {
    pub quote: Pubkey,
    pub market: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub tick: i32,
    pub units: u64,
    pub payment: u64,
}

#[event]
pub struct Repaid {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub units: u64,
}

#[event]
pub struct MockPriceSet {
    pub market: Pubkey,
    pub price_e6: u64,
    pub conf_e6: u64,
}

#[event]
pub struct Redeemed {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub units: u64,
    pub payout: u64,
}

#[event]
pub struct Liquidated {
    pub market: Pubkey,
    pub borrower: Pubkey,
    pub liquidator: Pubkey,
    /// 0 = health path, 1 = default path.
    pub path: u8,
    pub repaid: u64,
    pub seized: u64,
    pub lif_wad: u64,
    pub bad_debt: u64,
}

#[event]
pub struct LossFactorUpdated {
    pub market: Pubkey,
    pub loss_factor_wad: u64,
    pub shortfall: u64,
}
