use crate::errors::ZoryaError;
use crate::math::oracle::OracleQuote;
use anchor_lang::prelude::*;

const MAX_CONF_BPS: u128 = 200; // 2%

/// Collateral value in loan atoms, then LLTV haircut.
pub fn max_debt_units(
    collateral_amount: u64,
    collateral_decimals: u8,
    price_e6: u64,
    conf_e6: u64,
    lltv_bps: u16,
) -> Result<u64> {
    let conservative = conservative_price_e6(price_e6, conf_e6)?;
    let scale = 10u128
        .checked_pow(collateral_decimals as u32)
        .ok_or(ZoryaError::MathOverflow)?;
    let value = (collateral_amount as u128)
        .checked_mul(conservative as u128)
        .ok_or(ZoryaError::MathOverflow)?
        .checked_div(scale)
        .ok_or(ZoryaError::MathOverflow)?;
    let max = value
        .checked_mul(lltv_bps as u128)
        .ok_or(ZoryaError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(ZoryaError::MathOverflow)?;
    u64::try_from(max).map_err(|_| error!(ZoryaError::MathOverflow))
}

pub fn conservative_price_e6(price_e6: u64, conf_e6: u64) -> Result<u64> {
    require!(price_e6 > 0, ZoryaError::InvalidOraclePrice);
    if conf_e6 > 0 {
        let bps = (conf_e6 as u128)
            .checked_mul(10_000)
            .ok_or(ZoryaError::MathOverflow)?
            / price_e6 as u128;
        require!(bps <= MAX_CONF_BPS, ZoryaError::OracleConfidenceTooWide);
    }
    let conservative = price_e6.saturating_sub(conf_e6).max(1);
    Ok(conservative)
}

pub fn is_healthy(
    debt_units: u64,
    collateral_amount: u64,
    collateral_decimals: u8,
    quote: &OracleQuote,
    lltv_bps: u16,
) -> Result<bool> {
    if debt_units == 0 {
        return Ok(true);
    }
    let max = max_debt_units(
        collateral_amount,
        collateral_decimals,
        quote.price_e6,
        quote.conf_e6,
        lltv_bps,
    )?;
    Ok(debt_units <= max)
}

pub fn assert_healthy(
    debt_units: u64,
    collateral_amount: u64,
    collateral_decimals: u8,
    quote: &OracleQuote,
    lltv_bps: u16,
) -> Result<()> {
    if debt_units == 0 {
        return Ok(());
    }
    let max = max_debt_units(
        collateral_amount,
        collateral_decimals,
        quote.price_e6,
        quote.conf_e6,
        lltv_bps,
    )?;
    require!(debt_units <= max, ZoryaError::Unhealthy);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ten_sol_at_200_usd_lltv_70() {
        // 10 SOL, $200, 9 decimals, price_e6 = 200_000_000
        let max = max_debt_units(10_000_000_000, 9, 200_000_000, 0, 7_000).unwrap();
        // value = 2_000_000_000 USDC atoms ($2000), * 70% = 1_400_000_000
        assert_eq!(max, 1_400_000_000);
    }

    #[test]
    fn rejects_wide_confidence() {
        assert!(conservative_price_e6(100, 3).is_err());
        assert!(conservative_price_e6(10_000, 200).is_ok());
    }

    #[test]
    fn zero_decimals_inflates_max_debt() {
        let honest = max_debt_units(1_000_000_000, 9, 200_000_000, 0, 7_000).unwrap();
        let spoofed = max_debt_units(1_000_000_000, 0, 200_000_000, 0, 7_000).unwrap();
        assert!(spoofed > honest);
        assert_eq!(honest, 140_000_000);
    }
}
