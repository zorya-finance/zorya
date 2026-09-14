use crate::errors::ZoryaError;
use crate::events::Redeemed;
use crate::math::units::{WAD, floor_mul_wad};
use crate::state::market::TermMarket;
use crate::state::position::ClaimPosition;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

pub fn redeem(ctx: Context<Redeem>, units: u64) -> Result<()> {
    require!(units > 0, ZoryaError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    require!(
        ctx.accounts.market.is_matured(now),
        ZoryaError::MarketNotMatured
    );
    require!(
        ctx.accounts.claim.credit_units >= units,
        ZoryaError::InsufficientCredit
    );

    let loss = ctx.accounts.market.loss_factor_wad.min(WAD);
    let value_wad = WAD.saturating_sub(loss);
    let available = ctx.accounts.loan_vault.amount;

    let (burned, payout) = if value_wad == 0 {
        (units, 0u64)
    } else {
        let max_from_cash = (available as u128)
            .checked_mul(crate::math::units::WAD_U128)
            .ok_or(ZoryaError::MathOverflow)?
            / value_wad as u128;
        let max_from_cash =
            u64::try_from(max_from_cash).map_err(|_| error!(ZoryaError::MathOverflow))?;
        let burned = units.min(max_from_cash);
        require!(burned > 0, ZoryaError::InsufficientVault);
        let payout = floor_mul_wad(burned, value_wad)?;
        (burned, payout)
    };

    if payout > 0 {
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
                    from: ctx.accounts.loan_vault.to_account_info(),
                    to: ctx.accounts.owner_loan.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                &[seeds],
            ),
            payout,
        )?;
    }

    ctx.accounts.claim.credit_units = ctx
        .accounts
        .claim
        .credit_units
        .checked_sub(burned)
        .ok_or(ZoryaError::MathOverflow)?;
    ctx.accounts.market.total_credit_units = ctx
        .accounts
        .market
        .total_credit_units
        .checked_sub(burned)
        .ok_or(ZoryaError::MathOverflow)?;
    ctx.accounts.market.sync_status(now);

    emit!(Redeemed {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        units: burned,
        payout,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    pub owner: Signer<'info>,
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
    pub market: Account<'info, TermMarket>,
    #[account(
        mut,
        seeds = [b"claim", market.key().as_ref(), owner.key().as_ref()],
        bump = claim.bump,
        has_one = owner,
        has_one = market
    )]
    pub claim: Account<'info, ClaimPosition>,
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
