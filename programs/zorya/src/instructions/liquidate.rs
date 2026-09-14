use crate::errors::ZoryaError;
use crate::events::{Liquidated, LossFactorUpdated};
use crate::math::health::{conservative_price_e6, is_healthy};
use crate::math::liquidation::{
    default_lif_wad, health_repay_cap, max_lif_wad, next_loss_factor, seized_collateral_atoms,
};
use crate::math::oracle::quote_for_market;
use crate::state::market::TermMarket;
use crate::state::oracle::MockPrice;
use crate::state::position::ObligationPosition;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

const PATH_HEALTH: u8 = 0;
const PATH_DEFAULT: u8 = 1;

pub fn liquidate_health(ctx: Context<Liquidate>, repaid: u64) -> Result<()> {
    liquidate(ctx, repaid, PATH_HEALTH)
}

pub fn liquidate_default(ctx: Context<Liquidate>, repaid: u64) -> Result<()> {
    liquidate(ctx, repaid, PATH_DEFAULT)
}

fn liquidate(ctx: Context<Liquidate>, repaid: u64, path: u8) -> Result<()> {
    require!(repaid > 0, ZoryaError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let obligation = &ctx.accounts.obligation;
    require!(obligation.debt_units >= repaid, ZoryaError::InsufficientDebt);
    require!(obligation.debt_units > 0, ZoryaError::NoDebt);

    let market = &ctx.accounts.market;
    let quote = quote_for_market(
        market,
        &ctx.accounts.mock_price,
        &ctx.accounts.price_update.to_account_info(),
        now,
    )?;
    let price = conservative_price_e6(quote.price_e6, quote.conf_e6)?;

    let lif = if path == PATH_HEALTH {
        require!(
            !is_healthy(
                obligation.debt_units,
                obligation.collateral_amount,
                market.collateral_decimals,
                &quote,
                market.lltv_bps,
            )?,
            ZoryaError::HealthyPosition
        );
        let cap = health_repay_cap(
            obligation.debt_units,
            obligation.collateral_amount,
            market.collateral_decimals,
            quote.price_e6,
            quote.conf_e6,
            market.lltv_bps,
            market.liquidation_cursor_bps,
            market.min_fill_units,
        )?;
        require!(repaid <= cap, ZoryaError::OverLiquidation);
        max_lif_wad(market.lltv_bps, market.liquidation_cursor_bps)?
    } else {
        require!(now > market.maturity_ts, ZoryaError::NotPastMaturity);
        let max = max_lif_wad(market.lltv_bps, market.liquidation_cursor_bps)?;
        default_lif_wad(now, market.maturity_ts, max)?
    };

    let mut seized = seized_collateral_atoms(
        repaid,
        lif,
        price,
        market.collateral_decimals,
    )?;
    seized = seized.min(obligation.collateral_amount);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.liquidator_loan.to_account_info(),
                to: ctx.accounts.loan_vault.to_account_info(),
                authority: ctx.accounts.liquidator.to_account_info(),
            },
        ),
        repaid,
    )?;

    let seeds = &[
        b"market".as_ref(),
        market.collateral_mint.as_ref(),
        market.loan_mint.as_ref(),
        &market.maturity_ts.to_le_bytes(),
        &market.lltv_bps.to_le_bytes(),
        &[market.bump],
    ];

    if seized > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.collateral_vault.to_account_info(),
                    to: ctx.accounts.liquidator_collateral.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                &[seeds],
            ),
            seized,
        )?;
    }

    let obligation = &mut ctx.accounts.obligation;
    obligation.debt_units = obligation
        .debt_units
        .checked_sub(repaid)
        .ok_or(ZoryaError::MathOverflow)?;
    obligation.collateral_amount = obligation
        .collateral_amount
        .checked_sub(seized)
        .ok_or(ZoryaError::MathOverflow)?;

    let market = &mut ctx.accounts.market;
    market.total_debt_units = market
        .total_debt_units
        .checked_sub(repaid)
        .ok_or(ZoryaError::MathOverflow)?;
    market.sync_status(now);

    let mut bad_debt = 0u64;
    if obligation.collateral_amount == 0 && obligation.debt_units > 0 {
        bad_debt = obligation.debt_units;
        let lf = next_loss_factor(
            market.loss_factor_wad,
            market.total_credit_units,
            bad_debt,
        )?;
        market.total_debt_units = market
            .total_debt_units
            .checked_sub(bad_debt)
            .ok_or(ZoryaError::MathOverflow)?;
        obligation.debt_units = 0;
        market.loss_factor_wad = lf;
        emit!(LossFactorUpdated {
            market: market.key(),
            loss_factor_wad: lf,
            shortfall: bad_debt,
        });
    }

    emit!(Liquidated {
        market: market.key(),
        borrower: obligation.owner,
        liquidator: ctx.accounts.liquidator.key(),
        path,
        repaid,
        seized,
        lif_wad: lif,
        bad_debt,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(mut)]
    pub liquidator: Signer<'info>,
    /// CHECK: PDA seed only; must match the obligation owner.
    pub borrower: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [
            b"market",
            market.collateral_mint.as_ref(),
            market.loan_mint.as_ref(),
            &market.maturity_ts.to_le_bytes(),
            &market.lltv_bps.to_le_bytes()
        ],
        bump = market.bump
    )]
    pub market: Box<Account<'info, TermMarket>>,
    #[account(
        mut,
        seeds = [b"obligation", market.key().as_ref(), borrower.key().as_ref()],
        bump = obligation.bump,
        has_one = market,
        constraint = obligation.owner == borrower.key() @ ZoryaError::Unauthorized
    )]
    pub obligation: Box<Account<'info, ObligationPosition>>,
    #[account(
        seeds = [b"mock-price", market.key().as_ref()],
        bump = mock_price.bump
    )]
    pub mock_price: Box<Account<'info, MockPrice>>,
    /// CHECK: Pyth `PriceUpdateV2` owner + layout are validated in `quote_for_market`.
    pub price_update: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = liquidator_loan.mint == market.loan_mint @ ZoryaError::MintMismatch,
        constraint = liquidator_loan.owner == liquidator.key()
    )]
    pub liquidator_loan: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = liquidator_collateral.mint == market.collateral_mint @ ZoryaError::MintMismatch,
        constraint = liquidator_collateral.owner == liquidator.key()
    )]
    pub liquidator_collateral: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"loan-vault", market.key().as_ref()],
        bump = market.loan_vault_bump,
        constraint = loan_vault.mint == market.loan_mint @ ZoryaError::MintMismatch,
        constraint = loan_vault.owner == market.key() @ ZoryaError::Unauthorized
    )]
    pub loan_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"collateral-vault", market.key().as_ref()],
        bump = market.collateral_vault_bump,
        constraint = collateral_vault.mint == market.collateral_mint @ ZoryaError::MintMismatch,
        constraint = collateral_vault.owner == market.key() @ ZoryaError::Unauthorized
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}
