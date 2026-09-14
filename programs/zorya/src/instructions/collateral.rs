use crate::errors::ZoryaError;
use crate::events::{CollateralDeposited, CollateralWithdrawn};
use crate::math::health::assert_healthy;
use crate::math::oracle::quote_for_market;
use crate::state::config::ProtocolConfig;
use crate::state::market::TermMarket;
use crate::state::oracle::MockPrice;
use crate::state::position::ObligationPosition;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, ZoryaError::ZeroAmount);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.owner_collateral.to_account_info(),
                to: ctx.accounts.collateral_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;

    let position = &mut ctx.accounts.obligation;
    if position.owner == Pubkey::default() {
        position.owner = ctx.accounts.owner.key();
        position.market = ctx.accounts.market.key();
        position.bump = ctx.bumps.obligation;
    }
    position.collateral_amount = position
        .collateral_amount
        .checked_add(amount)
        .ok_or(ZoryaError::MathOverflow)?;

    emit!(CollateralDeposited {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        amount,
    });
    Ok(())
}

pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, ZoryaError::ZeroAmount);
    require!(!ctx.accounts.config.paused, ZoryaError::Paused);
    require!(
        ctx.accounts.obligation.collateral_amount >= amount,
        ZoryaError::InsufficientCollateral
    );

    let remaining = ctx.accounts.obligation.collateral_amount - amount;
    let now = Clock::get()?.unix_timestamp;
    let quote = quote_for_market(
        &ctx.accounts.market,
        &ctx.accounts.mock_price,
        &ctx.accounts.price_update.to_account_info(),
        now,
    )?;
    assert_healthy(
        ctx.accounts.obligation.debt_units,
        remaining,
        ctx.accounts.market.collateral_decimals,
        &quote,
        ctx.accounts.market.lltv_bps,
    )?;

    let market = &ctx.accounts.market;
    let seeds = &[
        b"market".as_ref(),
        market.collateral_mint.as_ref(),
        market.loan_mint.as_ref(),
        &market.maturity_ts.to_le_bytes(),
        &market.lltv_bps.to_le_bytes(),
        &[market.bump],
    ];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.collateral_vault.to_account_info(),
                to: ctx.accounts.owner_collateral.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    ctx.accounts.obligation.collateral_amount = remaining;

    emit!(CollateralWithdrawn {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        amount,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub market: Account<'info, TermMarket>,
    #[account(
        constraint = collateral_mint.key() == market.collateral_mint @ ZoryaError::MintMismatch
    )]
    pub collateral_mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = owner_collateral.mint == market.collateral_mint @ ZoryaError::MintMismatch,
        constraint = owner_collateral.owner == owner.key()
    )]
    pub owner_collateral: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"collateral-vault", market.key().as_ref()],
        bump = market.collateral_vault_bump,
        constraint = collateral_vault.mint == market.collateral_mint @ ZoryaError::MintMismatch,
        constraint = collateral_vault.owner == market.key() @ ZoryaError::Unauthorized
    )]
    pub collateral_vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + ObligationPosition::INIT_SPACE,
        seeds = [b"obligation", market.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub obligation: Account<'info, ObligationPosition>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    pub market: Account<'info, TermMarket>,
    #[account(
        constraint = collateral_mint.key() == market.collateral_mint @ ZoryaError::MintMismatch
    )]
    pub collateral_mint: Account<'info, Mint>,
    #[account(
        seeds = [b"mock-price", market.key().as_ref()],
        bump = mock_price.bump
    )]
    pub mock_price: Account<'info, MockPrice>,
    /// CHECK: Pyth `PriceUpdateV2` owner + layout are validated in `quote_for_market`.
    pub price_update: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = owner_collateral.mint == market.collateral_mint @ ZoryaError::MintMismatch,
        constraint = owner_collateral.owner == owner.key()
    )]
    pub owner_collateral: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"collateral-vault", market.key().as_ref()],
        bump = market.collateral_vault_bump,
        constraint = collateral_vault.mint == market.collateral_mint @ ZoryaError::MintMismatch,
        constraint = collateral_vault.owner == market.key() @ ZoryaError::Unauthorized
    )]
    pub collateral_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"obligation", market.key().as_ref(), owner.key().as_ref()],
        bump = obligation.bump,
        has_one = owner,
        has_one = market
    )]
    pub obligation: Account<'info, ObligationPosition>,
    pub token_program: Program<'info, Token>,
}
