use crate::errors::ZoryaError;
use crate::events::Repaid;
use crate::state::market::TermMarket;
use crate::state::position::ObligationPosition;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

pub fn repay(ctx: Context<Repay>, units: u64) -> Result<()> {
    require!(units > 0, ZoryaError::ZeroAmount);
    require!(
        ctx.accounts.obligation.debt_units >= units,
        ZoryaError::InsufficientDebt
    );

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.owner_loan.to_account_info(),
                to: ctx.accounts.loan_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        units,
    )?;

    ctx.accounts.obligation.debt_units = ctx
        .accounts
        .obligation
        .debt_units
        .checked_sub(units)
        .ok_or(ZoryaError::MathOverflow)?;
    ctx.accounts.market.total_debt_units = ctx
        .accounts
        .market
        .total_debt_units
        .checked_sub(units)
        .ok_or(ZoryaError::MathOverflow)?;

    emit!(Repaid {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        units,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Repay<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, TermMarket>,
    #[account(
        mut,
        seeds = [b"obligation", market.key().as_ref(), owner.key().as_ref()],
        bump = obligation.bump,
        has_one = owner,
        has_one = market
    )]
    pub obligation: Account<'info, ObligationPosition>,
    #[account(
        mut,
        constraint = owner_loan.mint == market.loan_mint @ ZoryaError::MintMismatch,
        constraint = owner_loan.owner == owner.key()
    )]
    pub owner_loan: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"loan-vault", market.key().as_ref()],
        bump = market.loan_vault_bump,
        constraint = loan_vault.mint == market.loan_mint @ ZoryaError::MintMismatch,
        constraint = loan_vault.owner == market.key() @ ZoryaError::Unauthorized
    )]
    pub loan_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
