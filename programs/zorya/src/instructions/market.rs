use crate::errors::ZoryaError;
use crate::events::MarketCreated;
use crate::state::config::ProtocolConfig;
use crate::math::oracle::PYTH_RECEIVER;
use crate::state::market::{
    Curve, DEFAULT_LIQ_CURSOR_BPS, DEFAULT_TICK_DELTA_BPS, MarketStatus, ORACLE_KIND_PYTH,
    TermMarket,
};
#[cfg(feature = "mock-oracle")]
use crate::state::market::ORACLE_KIND_MOCK;
use crate::state::oracle::MockPrice;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

/// Localnet / mock builds allow a short tenor so redeem and default
/// liquidation can be tested without warping validator time.
#[cfg(feature = "mock-oracle")]
pub const MIN_MATURITY_SECS: i64 = 2;
#[cfg(not(feature = "mock-oracle"))]
pub const MIN_MATURITY_SECS: i64 = 30 * 24 * 60 * 60;
/// Localnet desk seeds calendar dates past the 180-day production cap.
#[cfg(feature = "mock-oracle")]
pub const MAX_MATURITY_SECS: i64 = 540 * 24 * 60 * 60;
#[cfg(not(feature = "mock-oracle"))]
pub const MAX_MATURITY_SECS: i64 = 180 * 24 * 60 * 60;

pub fn create_market(
    ctx: Context<CreateMarket>,
    maturity_ts: i64,
    lltv_bps: u16,
    liquidation_cursor_bps: u16,
    tick_delta_bps: u16,
    min_fill_units: u64,
    oracle_feed_id: [u8; 32],
) -> Result<()> {
    require!(!ctx.accounts.config.paused, ZoryaError::Paused);
    require!(
        ctx.accounts.config.allows_lltv(lltv_bps),
        ZoryaError::LltvNotAllowed
    );
    require!(
        ctx.accounts.collateral_mint.key() != ctx.accounts.loan_mint.key(),
        ZoryaError::MintsMustDiffer
    );
    require!(min_fill_units > 0, ZoryaError::ZeroAmount);
    require!(
        liquidation_cursor_bps == DEFAULT_LIQ_CURSOR_BPS,
        ZoryaError::InvalidMarketParams
    );
    require!(
        tick_delta_bps == DEFAULT_TICK_DELTA_BPS,
        ZoryaError::InvalidMarketParams
    );

    let now = Clock::get()?.unix_timestamp;
    let ttm = maturity_ts.checked_sub(now).ok_or(ZoryaError::InvalidMaturity)?;
    require!(
        ttm >= MIN_MATURITY_SECS && ttm <= MAX_MATURITY_SECS,
        ZoryaError::InvalidMaturity
    );

    let zero_feed = [0u8; 32];
    let (oracle_kind, oracle_program) = if oracle_feed_id == zero_feed {
        #[cfg(not(feature = "mock-oracle"))]
        {
            return err!(ZoryaError::InvalidMarketParams);
        }
        #[cfg(feature = "mock-oracle")]
        {
            (ORACLE_KIND_MOCK, crate::ID)
        }
    } else {
        (ORACLE_KIND_PYTH, PYTH_RECEIVER)
    };

    let market = &mut ctx.accounts.market;
    market.collateral_mint = ctx.accounts.collateral_mint.key();
    market.loan_mint = ctx.accounts.loan_mint.key();
    market.oracle_program = oracle_program;
    market.oracle_feed_id = oracle_feed_id;
    market.lltv_bps = lltv_bps;
    market.liquidation_cursor_bps = liquidation_cursor_bps;
    market.maturity_ts = maturity_ts;
    market.tick_delta_bps = tick_delta_bps;
    market.min_fill_units = min_fill_units;
    market.status = MarketStatus::Active;
    market.total_credit_units = 0;
    market.total_debt_units = 0;
    market.loss_factor_wad = 0;
    market.settlement_fee_bps = 0;
    market.oracle_kind = oracle_kind;
    market.collateral_decimals = ctx.accounts.collateral_mint.decimals;
    market.loan_decimals = ctx.accounts.loan_mint.decimals;
    market.loan_vault_bump = ctx.bumps.loan_vault;
    market.collateral_vault_bump = ctx.bumps.collateral_vault;
    market.bump = ctx.bumps.market;

    ctx.accounts.curve.upsert_tenor(
        market.collateral_mint,
        market.loan_mint,
        maturity_ts,
        ctx.bumps.curve,
    )?;

    let mock = &mut ctx.accounts.mock_price;
    mock.market = market.key();
    mock.price_e6 = 0;
    mock.conf_e6 = 0;
    mock.bump = ctx.bumps.mock_price;

    emit!(MarketCreated {
        market: market.key(),
        collateral_mint: market.collateral_mint,
        loan_mint: market.loan_mint,
        maturity_ts,
        lltv_bps,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(maturity_ts: i64, lltv_bps: u16)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ ZoryaError::Unauthorized
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    pub loan_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = authority,
        space = 8 + TermMarket::INIT_SPACE,
        seeds = [
            b"market",
            collateral_mint.key().as_ref(),
            loan_mint.key().as_ref(),
            &maturity_ts.to_le_bytes(),
            &lltv_bps.to_le_bytes()
        ],
        bump
    )]
    pub market: Box<Account<'info, TermMarket>>,
    #[account(
        init,
        payer = authority,
        token::mint = loan_mint,
        token::authority = market,
        seeds = [b"loan-vault", market.key().as_ref()],
        bump
    )]
    pub loan_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = authority,
        token::mint = collateral_mint,
        token::authority = market,
        seeds = [b"collateral-vault", market.key().as_ref()],
        bump
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + Curve::INIT_SPACE,
        seeds = [b"curve", collateral_mint.key().as_ref(), loan_mint.key().as_ref()],
        bump
    )]
    pub curve: Box<Account<'info, Curve>>,
    #[account(
        init,
        payer = authority,
        space = 8 + MockPrice::INIT_SPACE,
        seeds = [b"mock-price", market.key().as_ref()],
        bump
    )]
    pub mock_price: Box<Account<'info, MockPrice>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
