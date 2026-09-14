use crate::errors::ZoryaError;
use crate::state::market::{ORACLE_KIND_MOCK, ORACLE_KIND_PYTH, TermMarket};
use crate::state::oracle::MockPrice;
use anchor_lang::prelude::*;

/// Q8 SAFE DEFAULT.
pub const PYTH_MAX_AGE_SECS: i64 = 30;

/// Pyth Solana Receiver — same program id on mainnet and devnet.
pub const PYTH_RECEIVER: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

/// SOL/USD feed id (`0xef0d8b6f…b56d`).
pub const SOL_USD_FEED_ID: [u8; 32] = [
    239, 13, 139, 111, 218, 44, 235, 164, 29, 161, 93, 64, 149, 209, 218, 57, 42, 13, 47, 142, 208,
    198, 199, 188, 15, 76, 250, 200, 194, 128, 181, 109,
];

/// `sha256("account:PriceUpdateV2")[0..8]`
const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParsedPythPrice {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OracleQuote {
    pub price_e6: u64,
    pub conf_e6: u64,
}

pub fn quote_from_mock(mock: &MockPrice) -> OracleQuote {
    OracleQuote {
        price_e6: mock.price_e6,
        conf_e6: mock.conf_e6,
    }
}

/// Mock markets read the PDA. Pyth markets read `PriceUpdateV2` owned by the Receiver.
pub fn quote_for_market(
    market: &TermMarket,
    mock: &MockPrice,
    price_update: &AccountInfo,
    now: i64,
) -> Result<OracleQuote> {
    if market.oracle_kind == ORACLE_KIND_PYTH {
        return quote_from_pyth_account(price_update, market, now);
    }
    require!(
        market.oracle_kind == ORACLE_KIND_MOCK,
        ZoryaError::InvalidMarketParams
    );
    #[cfg(not(feature = "mock-oracle"))]
    {
        let _ = (mock, price_update);
        return err!(ZoryaError::InvalidMarketParams);
    }
    #[cfg(feature = "mock-oracle")]
    {
        let _ = price_update;
        Ok(quote_from_mock(mock))
    }
}

fn quote_from_pyth_account(
    price_update: &AccountInfo,
    market: &TermMarket,
    now: i64,
) -> Result<OracleQuote> {
    require!(
        market.oracle_program == PYTH_RECEIVER,
        ZoryaError::OracleOwnerMismatch
    );
    require!(
        price_update.owner == &market.oracle_program,
        ZoryaError::OracleOwnerMismatch
    );
    let data = price_update.try_borrow_data()?;
    let parsed = parse_price_update_v2(&data)?;
    validate_pyth_quote(
        parsed.price,
        parsed.conf,
        parsed.exponent,
        parsed.publish_time,
        now,
        &parsed.feed_id,
        &market.oracle_feed_id,
        market.loan_decimals,
    )
}

/// Manual `PriceUpdateV2` decode — avoids `pyth-solana-receiver-sdk` (SBF / edition2024).
pub fn parse_price_update_v2(data: &[u8]) -> Result<ParsedPythPrice> {
    require!(data.len() >= 8 + 32 + 1 + 84, ZoryaError::InvalidOraclePrice);
    require!(
        data[0..8] == PRICE_UPDATE_V2_DISCRIMINATOR,
        ZoryaError::InvalidOraclePrice
    );
    let mut i = 8 + 32;
    let level = data[i];
    i += 1;
    require!(level != 0, ZoryaError::OracleNotFullyVerified);
    require!(level == 1, ZoryaError::OracleNotFullyVerified);
    require!(data.len() >= i + 84, ZoryaError::InvalidOraclePrice);

    let mut feed_id = [0u8; 32];
    feed_id.copy_from_slice(&data[i..i + 32]);
    i += 32;
    let price = i64::from_le_bytes(read_arr(&data[i..i + 8])?);
    i += 8;
    let conf = u64::from_le_bytes(read_arr(&data[i..i + 8])?);
    i += 8;
    let exponent = i32::from_le_bytes(read_arr(&data[i..i + 4])?);
    i += 4;
    let publish_time = i64::from_le_bytes(read_arr(&data[i..i + 8])?);

    Ok(ParsedPythPrice {
        feed_id,
        price,
        conf,
        exponent,
        publish_time,
    })
}

/// Convert a Pyth price (`price * 10^expo` USD per whole collateral) into
/// loan-mint atoms per 1 whole collateral token, then the same scale for `conf`.
///
/// Example: SOL/USD `price=20_000_000_000`, `expo=-8` → $200.
/// USDC 6 dp → `price_e6 = 200_000_000`.
pub fn pyth_to_loan_atoms(
    price: i64,
    conf: u64,
    expo: i32,
    loan_decimals: u8,
) -> Result<(u64, u64)> {
    require!(price > 0, ZoryaError::InvalidOraclePrice);
    let price_e6 = scale_signed(price, expo, loan_decimals)?;
    require!(price_e6 > 0, ZoryaError::InvalidOraclePrice);
    let conf_e6 = if conf == 0 {
        0
    } else {
        scale_unsigned(conf, expo, loan_decimals)?
    };
    Ok((price_e6, conf_e6))
}

/// Full Pyth pull checks (feed, age, sign, confidence, scale).
pub fn validate_pyth_quote(
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
    now: i64,
    feed_id: &[u8; 32],
    expected_feed: &[u8; 32],
    loan_decimals: u8,
) -> Result<OracleQuote> {
    require!(feed_id == expected_feed, ZoryaError::OracleFeedMismatch);
    require!(publish_time <= now, ZoryaError::OraclePriceStale);
    require!(
        now.saturating_sub(publish_time) <= PYTH_MAX_AGE_SECS,
        ZoryaError::OraclePriceStale
    );
    let (price_e6, conf_e6) = pyth_to_loan_atoms(price, conf, expo, loan_decimals)?;
    crate::math::health::conservative_price_e6(price_e6, conf_e6)?;
    Ok(OracleQuote { price_e6, conf_e6 })
}

fn read_arr<const N: usize>(slice: &[u8]) -> Result<[u8; N]> {
    <[u8; N]>::try_from(slice).map_err(|_| error!(ZoryaError::InvalidOraclePrice))
}

fn scale_signed(price: i64, expo: i32, loan_decimals: u8) -> Result<u64> {
    scale_unsigned(price as u64, expo, loan_decimals)
}

fn scale_unsigned(raw: u64, expo: i32, loan_decimals: u8) -> Result<u64> {
    let shift = (expo as i128)
        .checked_add(loan_decimals as i128)
        .ok_or(ZoryaError::MathOverflow)?;
    let base = raw as u128;
    let out = if shift >= 0 {
        let factor = 10u128
            .checked_pow(shift as u32)
            .ok_or(ZoryaError::MathOverflow)?;
        base.checked_mul(factor).ok_or(ZoryaError::MathOverflow)?
    } else {
        let factor = 10u128
            .checked_pow((-shift) as u32)
            .ok_or(ZoryaError::MathOverflow)?;
        base / factor
    };
    u64::try_from(out).map_err(|_| error!(ZoryaError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOL_USD: [u8; 32] = [7; 32];

    #[test]
    fn sol_usd_to_usdc_atoms() {
        let (p, c) = pyth_to_loan_atoms(20_000_000_000, 10_000_000, -8, 6).unwrap();
        assert_eq!(p, 200_000_000);
        assert_eq!(c, 100_000);
    }

    #[test]
    fn rejects_non_positive_price() {
        assert!(pyth_to_loan_atoms(0, 0, -8, 6).is_err());
        assert!(pyth_to_loan_atoms(-5, 0, -8, 6).is_err());
    }

    #[test]
    fn rejects_stale_and_future() {
        let now = 1_000_000i64;
        assert!(validate_pyth_quote(
            20_000_000_000, 0, -8, now - 31, now, &SOL_USD, &SOL_USD, 6
        )
        .is_err());
        assert!(validate_pyth_quote(
            20_000_000_000, 0, -8, now + 1, now, &SOL_USD, &SOL_USD, 6
        )
        .is_err());
        assert!(validate_pyth_quote(
            20_000_000_000, 0, -8, now - 30, now, &SOL_USD, &SOL_USD, 6
        )
        .is_ok());
    }

    #[test]
    fn rejects_feed_substitution() {
        let other = [8; 32];
        assert!(validate_pyth_quote(
            20_000_000_000, 0, -8, 10, 10, &other, &SOL_USD, 6
        )
        .is_err());
    }

    #[test]
    fn rejects_wide_confidence() {
        // 3% conf after scale
        assert!(validate_pyth_quote(
            10_000, 300, 0, 10, 10, &SOL_USD, &SOL_USD, 0
        )
        .is_err());
    }

    fn encode_price_update(
        level: u8,
        extra_partial_sig: Option<u8>,
        feed: [u8; 32],
        price: i64,
        conf: u64,
        expo: i32,
        publish: i64,
    ) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&PRICE_UPDATE_V2_DISCRIMINATOR);
        data.extend_from_slice(&[7u8; 32]);
        data.push(level);
        if let Some(n) = extra_partial_sig {
            data.push(n);
        }
        data.extend_from_slice(&feed);
        data.extend_from_slice(&price.to_le_bytes());
        data.extend_from_slice(&conf.to_le_bytes());
        data.extend_from_slice(&expo.to_le_bytes());
        data.extend_from_slice(&publish.to_le_bytes());
        data.extend_from_slice(&0i64.to_le_bytes());
        data.extend_from_slice(&0i64.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data
    }

    #[test]
    fn parses_full_price_update_v2() {
        let data = encode_price_update(
            1,
            None,
            SOL_USD_FEED_ID,
            20_000_000_000,
            10_000_000,
            -8,
            1_000,
        );
        let parsed = parse_price_update_v2(&data).unwrap();
        assert_eq!(parsed.feed_id, SOL_USD_FEED_ID);
        assert_eq!(parsed.price, 20_000_000_000);
        assert_eq!(parsed.conf, 10_000_000);
        assert_eq!(parsed.exponent, -8);
        assert_eq!(parsed.publish_time, 1_000);
        let quote = validate_pyth_quote(
            parsed.price,
            parsed.conf,
            parsed.exponent,
            parsed.publish_time,
            1_000,
            &parsed.feed_id,
            &SOL_USD_FEED_ID,
            6,
        )
        .unwrap();
        assert_eq!(quote.price_e6, 200_000_000);
        assert_eq!(quote.conf_e6, 100_000);
    }

    #[test]
    fn rejects_partial_verification() {
        let data = encode_price_update(0, Some(5), SOL_USD_FEED_ID, 1, 0, 0, 10);
        assert!(parse_price_update_v2(&data).is_err());
    }

    #[test]
    fn rejects_bad_discriminator() {
        let mut data = encode_price_update(1, None, SOL_USD_FEED_ID, 1, 0, 0, 10);
        data[0] = 0;
        assert!(parse_price_update_v2(&data).is_err());
    }

    #[test]
    fn rejects_unknown_verification_level() {
        let data = encode_price_update(2, None, SOL_USD_FEED_ID, 1, 0, 0, 10);
        assert!(parse_price_update_v2(&data).is_err());
    }

    #[test]
    fn parsed_update_rejects_feed_mismatch() {
        let other = [9u8; 32];
        let data = encode_price_update(1, None, other, 20_000_000_000, 0, -8, 10);
        let parsed = parse_price_update_v2(&data).unwrap();
        assert!(validate_pyth_quote(
            parsed.price,
            parsed.conf,
            parsed.exponent,
            parsed.publish_time,
            10,
            &parsed.feed_id,
            &SOL_USD_FEED_ID,
            6,
        )
        .is_err());
    }
}
