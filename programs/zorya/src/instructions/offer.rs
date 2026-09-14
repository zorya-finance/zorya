use crate::errors::ZoryaError;
use crate::events::{QuoteCancelled, QuoteCreated};
use crate::math::ticks::tick_to_price_wad;
use crate::math::units::ceil_mul_wad;
use crate::state::config::ProtocolConfig;
use crate::state::market::{MarketStatus, TermMarket};
use crate::state::offer::Quote;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

pub fn create_quote(ctx: Context<CreateQuote>, quote_seq: u64, tick: i32, units: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, ZoryaError::Paused);
    require!(
        ctx.accounts.market.status == MarketStatus::Active,
        ZoryaError::MarketNotActive
    );
    require!(units > 0, ZoryaError::ZeroAmount);
    require!(
        units >= ctx.accounts.market.min_fill_units,
        ZoryaError::FillTooSmall
    );
    let now = Clock::get()?.unix_timestamp;
    require!(
        !ctx.accounts.market.is_matured(now),
        ZoryaError::MarketMatured
    );

    let price = tick_to_price_wad(tick, ctx.accounts.market.tick_delta_bps)?;
    let escrow = ceil_mul_wad(units, price)?;
    require!(escrow > 0, ZoryaError::ZeroAmount);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.maker_loan.to_account_info(),
                to: ctx.accounts.quote_vault.to_account_info(),
                authority: ctx.accounts.maker.to_account_info(),
            },
        ),
        escrow,
    )?;

    let quote = &mut ctx.accounts.quote;
    quote.maker = ctx.accounts.maker.key();
    quote.market = ctx.accounts.market.key();
    quote.quote_seq = quote_seq;
    quote.tick = tick;
    quote.remaining_units = units;
    quote.escrowed_loan = escrow;
    quote.created_at = now;
    quote.bump = ctx.bumps.quote;

    emit!(QuoteCreated {
        quote: quote.key(),
        market: quote.market,
        maker: quote.maker,
        tick,
        units,
        escrowed_loan: escrow,
    });
    Ok(())
}

pub fn cancel_quote(ctx: Context<CancelQuote>) -> Result<()> {
    let leftover = ctx.accounts.quote_vault.amount;
    let seq = ctx.accounts.quote.quote_seq.to_le_bytes();
    let bump = ctx.accounts.quote.bump;
    let market_key = ctx.accounts.market.key();
    let maker_key = ctx.accounts.maker.key();
    let seeds: &[&[u8]] = &[
        b"quote",
        market_key.as_ref(),
        maker_key.as_ref(),
        seq.as_ref(),
        &[bump],
    ];

    if leftover > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.quote_vault.to_account_info(),
                    to: ctx.accounts.maker_loan.to_account_info(),
                    authority: ctx.accounts.quote.to_account_info(),
                },
                &[seeds],
            ),
            leftover,
        )?;
    }

    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.quote_vault.to_account_info(),
            destination: ctx.accounts.maker.to_account_info(),
            authority: ctx.accounts.quote.to_account_info(),
        },
        &[seeds],
    ))?;

    emit!(QuoteCancelled {
        quote: ctx.accounts.quote.key(),
        maker: ctx.accounts.maker.key(),
        returned_loan: leftover,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(quote_seq: u64)]
pub struct CreateQuote<'info> {
    /// Rent payer. Separate from `maker` so a PDA (product vault) can be the maker.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub maker: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    pub market: Account<'info, TermMarket>,
    #[account(
        constraint = loan_mint.key() == market.loan_mint @ ZoryaError::MintMismatch
    )]
    pub loan_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = 8 + Quote::INIT_SPACE,
        seeds = [
            b"quote",
            market.key().as_ref(),
            maker.key().as_ref(),
            &quote_seq.to_le_bytes()
        ],
        bump
    )]
    pub quote: Account<'info, Quote>,
    #[account(
        init,
        payer = payer,
        token::mint = loan_mint,
        token::authority = quote,
        seeds = [b"quote-vault", quote.key().as_ref()],
        bump
    )]
    pub quote_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = maker_loan.mint == market.loan_mint @ ZoryaError::MintMismatch,
        constraint = maker_loan.owner == maker.key()
    )]
    pub maker_loan: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelQuote<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub market: Account<'info, TermMarket>,
    #[account(
        mut,
        seeds = [
            b"quote",
            market.key().as_ref(),
            maker.key().as_ref(),
            &quote.quote_seq.to_le_bytes()
        ],
        bump = quote.bump,
        has_one = maker,
        has_one = market,
        close = maker
    )]
    pub quote: Account<'info, Quote>,
    #[account(
        mut,
        seeds = [b"quote-vault", quote.key().as_ref()],
        bump,
        constraint = quote_vault.mint == market.loan_mint @ ZoryaError::MintMismatch,
        constraint = quote_vault.owner == quote.key() @ ZoryaError::Unauthorized
    )]
    pub quote_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = maker_loan.mint == market.loan_mint @ ZoryaError::MintMismatch,
        constraint = maker_loan.owner == maker.key()
    )]
    pub maker_loan: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
