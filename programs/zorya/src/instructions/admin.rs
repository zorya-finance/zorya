use crate::errors::ZoryaError;
use crate::events::{ConfigInitialized, PauseUpdated};
use crate::state::config::{BTC_LLTV_BPS, DEFAULT_LLTV_BPS, ProtocolConfig};
#[cfg(feature = "mock-oracle")]
use crate::events::MockPriceSet;
#[cfg(feature = "mock-oracle")]
use crate::state::market::{ORACLE_KIND_MOCK, TermMarket};
#[cfg(feature = "mock-oracle")]
use crate::state::oracle::MockPrice;
use anchor_lang::prelude::*;

pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.pending_authority = Pubkey::default();
    config.paused = false;
    config.lltv_count = 2;
    config.allowed_lltv_bps = [0; 8];
    config.allowed_lltv_bps[0] = DEFAULT_LLTV_BPS;
    config.allowed_lltv_bps[1] = BTC_LLTV_BPS;
    config.bump = ctx.bumps.config;
    emit!(ConfigInitialized {
        authority: config.authority,
    });
    Ok(())
}

pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    emit!(PauseUpdated { paused });
    Ok(())
}

#[cfg(feature = "mock-oracle")]
pub fn set_mock_price(ctx: Context<SetMockPrice>, price_e6: u64, conf_e6: u64) -> Result<()> {
    require!(
        ctx.accounts.market.oracle_kind == ORACLE_KIND_MOCK,
        ZoryaError::InvalidMarketParams
    );
    require!(price_e6 > 0, ZoryaError::InvalidOraclePrice);
    let mock = &mut ctx.accounts.mock_price;
    mock.market = ctx.accounts.market.key();
    mock.price_e6 = price_e6;
    mock.conf_e6 = conf_e6;
    mock.bump = ctx.bumps.mock_price;
    emit!(MockPriceSet {
        market: mock.market,
        price_e6,
        conf_e6,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ ZoryaError::Unauthorized
    )]
    pub config: Account<'info, ProtocolConfig>,
}

#[cfg(feature = "mock-oracle")]
#[derive(Accounts)]
pub struct SetMockPrice<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ ZoryaError::Unauthorized
    )]
    pub config: Account<'info, ProtocolConfig>,
    pub market: Account<'info, TermMarket>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + MockPrice::INIT_SPACE,
        seeds = [b"mock-price", market.key().as_ref()],
        bump
    )]
    pub mock_price: Account<'info, MockPrice>,
    pub system_program: Program<'info, System>,
}
