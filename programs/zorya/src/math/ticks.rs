use crate::errors::ZoryaError;
use crate::math::units::WAD_U128;
use crate::state::market::TICK_N;
use anchor_lang::prelude::*;

/// ε = 1e-6 in WAD space (1e18 * 1e-6 = 1e12).
const EPS_WAD: u128 = 1_000_000_000_000;

/// `P = 1 / (1 + (1+δ)^(N/2 − tick))`, then quantized to 1e-6, ties down.
/// `tick_delta_bps` is δ in basis points (200 = 2% = 0.02).
pub fn tick_to_price_wad(tick: i32, tick_delta_bps: u16) -> Result<u64> {
    require!(tick >= 0 && tick <= TICK_N, ZoryaError::InvalidTick);
    require!(tick_delta_bps > 0, ZoryaError::InvalidTick);

    let exp = (TICK_N / 2) - tick;
    let one_plus_delta_num = 10_000u128
        .checked_add(tick_delta_bps as u128)
        .ok_or(ZoryaError::MathOverflow)?;
    let factor = pow_ratio_wad(one_plus_delta_num, 10_000, exp)?;
    let denom = WAD_U128
        .checked_add(factor)
        .ok_or(ZoryaError::MathOverflow)?;
    let unquant = WAD_U128
        .checked_mul(WAD_U128)
        .ok_or(ZoryaError::MathOverflow)?
        .checked_div(denom)
        .ok_or(ZoryaError::MathOverflow)?;
    let price = quantize_eps(unquant)?;
    require!(price > 0 && price < WAD_U128, ZoryaError::PriceAtOrAbovePar);
    u64::try_from(price).map_err(|_| error!(ZoryaError::MathOverflow))
}

fn pow_ratio_wad(num: u128, den: u128, exp: i32) -> Result<u128> {
    let mut result = WAD_U128;
    if exp >= 0 {
        for _ in 0..exp {
            result = result
                .checked_mul(num)
                .ok_or(ZoryaError::MathOverflow)?
                .checked_div(den)
                .ok_or(ZoryaError::MathOverflow)?;
        }
    } else {
        for _ in 0..(-exp) {
            result = result
                .checked_mul(den)
                .ok_or(ZoryaError::MathOverflow)?
                .checked_div(num)
                .ok_or(ZoryaError::MathOverflow)?;
        }
    }
    Ok(result)
}

/// Nearest multiple of ε; ties round down.
fn quantize_eps(value: u128) -> Result<u128> {
    let q = value / EPS_WAD;
    let rem = value % EPS_WAD;
    let adj = if rem > EPS_WAD / 2 { q.checked_add(1).ok_or(ZoryaError::MathOverflow)? } else { q };
    adj.checked_mul(EPS_WAD).ok_or(error!(ZoryaError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::units::WAD;

    #[test]
    fn mid_tick_is_half() {
        // n = 256 → (1.02)^0 = 1 → P = 1/2
        let p = tick_to_price_wad(256, 200).unwrap();
        assert_eq!(p, WAD / 2);
    }

    #[test]
    fn higher_tick_is_closer_to_par() {
        let low = tick_to_price_wad(200, 200).unwrap();
        let high = tick_to_price_wad(300, 200).unwrap();
        assert!(high > low);
        assert!(high < WAD);
    }

    #[test]
    fn rejects_out_of_range() {
        assert!(tick_to_price_wad(-1, 200).is_err());
        assert!(tick_to_price_wad(513, 200).is_err());
    }

    #[test]
    fn q5_grid_is_strictly_increasing_and_below_par() {
        let mut prev = 0u64;
        for tick in 0..=TICK_N {
            let p = tick_to_price_wad(tick, 200).unwrap();
            assert!(p > prev, "tick {tick}");
            assert!(p < WAD, "tick {tick}");
            prev = p;
        }
    }

    #[test]
    fn q5_regression_samples() {
        // Locked after the first green cargo test. Recompute only if the formula changes.
        assert_eq!(tick_to_price_wad(0, 200).unwrap(), 6_246_000_000_000_000);
        assert_eq!(tick_to_price_wad(256, 200).unwrap(), 500_000_000_000_000_000);
        assert_eq!(tick_to_price_wad(512, 200).unwrap(), 993_754_000_000_000_000);
    }
}
