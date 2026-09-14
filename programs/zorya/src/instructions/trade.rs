use crate::errors::ZoryaError;
use crate::events::QuoteFilled;
use crate::math::health::assert_healthy;
use crate::math::oracle::quote_for_market;
use crate::math::ticks::tick_to_price_wad;
use crate::math::units::floor_mul_wad;
use crate::state::config::ProtocolConfig;
use crate::state::market::{Curve, MarketStatus, TermMarket};
use crate::state::offer::Quote;
use crate::state::oracle::MockPrice;
use crate::state::position::{ClaimPosition, ObligationPosition};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub fn fill_quote(ctx: Context<FillQuote>, max_units: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, ZoryaError::Paused);
    require!(
        ctx.accounts.market.status == MarketStatus::Active,
        ZoryaError::MarketNotActive
    );
    let now = Clock::get()?.unix_timestamp;
    require!(
        !ctx.accounts.market.is_matured(now),
        ZoryaError::MarketMatured
    );
    require!(max_units > 0, ZoryaError::ZeroAmount);
    require!(
        ctx.accounts.taker.key() != ctx.accounts.quote.maker,
        ZoryaError::SelfTrade
    );
    require!(ctx.accounts.quote.remaining_units > 0, ZoryaError::ZeroAmount);

    let units = max_units.min(ctx.accounts.quote.remaining_units);
    require!(
        units >= ctx.accounts.market.min_fill_units
            || units == ctx.accounts.quote.remaining_units,
        ZoryaError::FillTooSmall
    );

    let price = tick_to_price_wad(ctx.accounts.quote.tick, ctx.accounts.market.tick_delta_bps)?;
    let payment = floor_mul_wad(units, price)?;
    require!(payment > 0, ZoryaError::ZeroAmount);
    require!(
        ctx.accounts.quote.escrowed_loan >= payment,
        ZoryaError::InsufficientEscrow
    );
    require!(
        ctx.accounts.quote_vault.amount >= payment,
        ZoryaError::InsufficientEscrow
    );

    let new_debt = ctx
        .accounts
        .obligation
        .debt_units
        .checked_add(units)
        .ok_or(ZoryaError::MathOverflow)?;
    let oracle_quote = quote_for_market(
        &ctx.accounts.market,
        &ctx.accounts.mock_price,
        &ctx.accounts.price_update.to_account_info(),
        now,
    )?;
    assert_healthy(
        new_debt,
        ctx.accounts.obligation.collateral_amount,
        ctx.accounts.market.collateral_decimals,
        &oracle_quote,
        ctx.accounts.market.lltv_bps,
    )?;

    let seq = ctx.accounts.quote.quote_seq.to_le_bytes();
    let bump = ctx.accounts.quote.bump;
    let maker = ctx.accounts.quote.maker;
    let market_key = ctx.accounts.market.key();
    let quote_seeds: &[&[u8]] = &[
        b"quote",
        market_key.as_ref(),
        maker.as_ref(),
        seq.as_ref(),
        &[bump],
    ];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.quote_vault.to_account_info(),
                to: ctx.accounts.taker_loan.to_account_info(),
                authority: ctx.accounts.quote.to_account_info(),
            },
            &[quote_seeds],
        ),
        payment,
    )?;

    let claim = &mut ctx.accounts.claim;
    if claim.owner == Pubkey::default() {
        claim.owner = ctx.accounts.quote.maker;
        claim.market = ctx.accounts.market.key();
        claim.bump = ctx.bumps.claim;
    } else {
        require!(
            claim.owner == ctx.accounts.quote.maker
                && claim.market == ctx.accounts.market.key(),
            ZoryaError::Unauthorized
        );
    }
    claim.credit_units = claim
        .credit_units
        .checked_add(units)
        .ok_or(ZoryaError::MathOverflow)?;

    let obligation = &mut ctx.accounts.obligation;
    obligation.debt_units = obligation
        .debt_units
        .checked_add(units)
        .ok_or(ZoryaError::MathOverflow)?;

    let market = &mut ctx.accounts.market;
    market.total_credit_units = market
        .total_credit_units
        .checked_add(units)
        .ok_or(ZoryaError::MathOverflow)?;
    market.total_debt_units = market
        .total_debt_units
        .checked_add(units)
        .ok_or(ZoryaError::MathOverflow)?;

    let remaining_after = ctx
        .accounts
        .quote
        .remaining_units
        .checked_sub(units)
        .ok_or(ZoryaError::MathOverflow)?;
    let escrow_after = ctx
        .accounts
        .quote
        .escrowed_loan
        .checked_sub(payment)
        .ok_or(ZoryaError::MathOverflow)?;
    let close_quote =
        remaining_after == 0 || remaining_after < market.min_fill_units;
    if close_quote && escrow_after > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.quote_vault.to_account_info(),
                    to: ctx.accounts.maker_loan.to_account_info(),
                    authority: ctx.accounts.quote.to_account_info(),
                },
                &[quote_seeds],
            ),
            escrow_after,
        )?;
    }

    let quote = &mut ctx.accounts.quote;
    if close_quote {
        quote.remaining_units = 0;
        quote.escrowed_loan = 0;
    } else {
        quote.remaining_units = remaining_after;
        quote.escrowed_loan = escrow_after;
    }

    ctx.accounts
        .curve
        .record_fill(market.maturity_ts, price, units, now)?;

    emit!(QuoteFilled {
        quote: quote.key(),
        market: market.key(),
        maker: quote.maker,
        taker: ctx.accounts.taker.key(),
        tick: quote.tick,
        units,
        payment,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct FillQuote<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut)]
    pub market: Box<Account<'info, TermMarket>>,
    #[account(
        constraint = collateral_mint.key() == market.collateral_mint @ ZoryaError::MintMismatch
    )]
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        seeds = [
            b"quote",
            market.key().as_ref(),
            quote.maker.as_ref(),
            &quote.quote_seq.to_le_bytes()
        ],
        bump = quote.bump,
        has_one = market
    )]
    pub quote: Box<Account<'info, Quote>>,
    #[account(
        mut,
        seeds = [b"quote-vault", quote.key().as_ref()],
        bump,
        constraint = quote_vault.mint == market.loan_mint @ ZoryaError::MintMismatch,
        constraint = quote_vault.owner == quote.key() @ ZoryaError::Unauthorized
    )]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = taker_loan.mint == market.loan_mint @ ZoryaError::MintMismatch,
        constraint = taker_loan.owner == taker.key()
    )]
    pub taker_loan: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = maker_loan.mint == market.loan_mint @ ZoryaError::MintMismatch,
        constraint = maker_loan.owner == quote.maker
    )]
    pub maker_loan: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = taker,
        space = 8 + ClaimPosition::INIT_SPACE,
        seeds = [b"claim", market.key().as_ref(), quote.maker.as_ref()],
        bump
    )]
    pub claim: Box<Account<'info, ClaimPosition>>,
    #[account(
        mut,
        seeds = [b"obligation", market.key().as_ref(), taker.key().as_ref()],
        bump = obligation.bump,
        has_one = market,
        constraint = obligation.owner == taker.key() @ ZoryaError::Unauthorized
    )]
    pub obligation: Box<Account<'info, ObligationPosition>>,
    #[account(
        seeds = [b"mock-price", market.key().as_ref()],
        bump = mock_price.bump
    )]
    pub mock_price: Box<Account<'info, MockPrice>>,
    /// CHECK: Pyth `PriceUpdateV2` owner + layout are validated in `quote_for_market`.
    /// Mock markets ignore this account (pass the mock-price PDA).
    pub price_update: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"curve", market.collateral_mint.as_ref(), market.loan_mint.as_ref()],
        bump = curve.bump,
        constraint = curve.pair_collateral == market.collateral_mint @ ZoryaError::CurvePairMismatch,
        constraint = curve.pair_loan == market.loan_mint @ ZoryaError::CurvePairMismatch
    )]
    pub curve: Box<Account<'info, Curve>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
