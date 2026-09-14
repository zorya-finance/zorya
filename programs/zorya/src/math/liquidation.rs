use crate::errors::ZoryaError;
use crate::math::health::max_debt_units;
use crate::math::units::{WAD, WAD_U128};
use crate::state::market::GRACE_SECONDS;
use anchor_lang::prelude::*;

/// `max_lif = WAD / (WAD − γ * (WAD − lltv_wad))` in WAD space.
pub fn max_lif_wad(lltv_bps: u16, cursor_bps: u16) -> Result<u64> {
    require!(lltv_bps < 10_000, ZoryaError::InvalidMarketParams);
    let lltv_wad = WAD_U128
        .checked_mul(lltv_bps as u128)
        .ok_or(ZoryaError::MathOverflow)?
        / 10_000;
    let gamma_wad = WAD_U128
        .checked_mul(cursor_bps as u128)
        .ok_or(ZoryaError::MathOverflow)?
        / 10_000;
    let gap = WAD_U128
        .checked_sub(lltv_wad)
        .ok_or(ZoryaError::MathOverflow)?;
    let haircut = gamma_wad
        .checked_mul(gap)
        .ok_or(ZoryaError::MathOverflow)?
        / WAD_U128;
    let denom = WAD_U128
        .checked_sub(haircut)
        .ok_or(ZoryaError::MathOverflow)?;
    require!(denom > 0, ZoryaError::MathOverflow);
    let lif = WAD_U128
        .checked_mul(WAD_U128)
        .ok_or(ZoryaError::MathOverflow)?
        / denom;
    u64::try_from(lif).map_err(|_| error!(ZoryaError::MathOverflow))
}

/// Linear ramp from 1.0 to `max_lif` over `GRACE_SECONDS` after maturity.
/// `now` must be strictly greater than `maturity_ts`.
pub fn default_lif_wad(now: i64, maturity_ts: i64, max_lif: u64) -> Result<u64> {
    require!(now > maturity_ts, ZoryaError::NotPastMaturity);
    let elapsed = (now - maturity_ts) as u128;
    let grace = GRACE_SECONDS as u128;
    let ramp = (elapsed.saturating_mul(WAD_U128) / grace).min(WAD_U128);
    let bonus = (max_lif as u128)
        .checked_sub(WAD_U128)
        .ok_or(ZoryaError::MathOverflow)?;
    let lif = WAD_U128
        + bonus
            .checked_mul(ramp)
            .ok_or(ZoryaError::MathOverflow)?
            / WAD_U128;
    u64::try_from(lif).map_err(|_| error!(ZoryaError::MathOverflow))
}

/// Collateral atoms seized for `repaid` loan atoms at `lif`, floor.
pub fn seized_collateral_atoms(
    repaid: u64,
    lif_wad: u64,
    price_e6: u64,
    collateral_decimals: u8,
) -> Result<u64> {
    require!(price_e6 > 0, ZoryaError::InvalidOraclePrice);
    let scale = 10u128
        .checked_pow(collateral_decimals as u32)
        .ok_or(ZoryaError::MathOverflow)?;
    let num = (repaid as u128)
        .checked_mul(lif_wad as u128)
        .ok_or(ZoryaError::MathOverflow)?
        .checked_mul(scale)
        .ok_or(ZoryaError::MathOverflow)?;
    let den = WAD_U128
        .checked_mul(price_e6 as u128)
        .ok_or(ZoryaError::MathOverflow)?;
    u64::try_from(num / den).map_err(|_| error!(ZoryaError::MathOverflow))
}

/// 0.01 whole collateral tokens, in atoms.
pub fn dust_collateral_atoms(collateral_decimals: u8) -> u64 {
    10u64.saturating_pow(collateral_decimals.saturating_sub(2) as u32)
}

/// Max repay on the health path (RCF). Dust leftover allows a full close.
pub fn health_repay_cap(
    debt: u64,
    collateral: u64,
    collateral_decimals: u8,
    price_e6: u64,
    conf_e6: u64,
    lltv_bps: u16,
    cursor_bps: u16,
    dust_debt: u64,
) -> Result<u64> {
    let max0 = max_debt_units(collateral, collateral_decimals, price_e6, conf_e6, lltv_bps)?;
    require!(debt > max0, ZoryaError::HealthyPosition);
    let lif = max_lif_wad(lltv_bps, cursor_bps)?;
    let conservative = crate::math::health::conservative_price_e6(price_e6, conf_e6)?;

    let lltv_wad = WAD_U128
        .checked_mul(lltv_bps as u128)
        .ok_or(ZoryaError::MathOverflow)?
        / 10_000;
    // denom_wad = WAD − lif * lltv_wad / WAD  (stays in u128, no WAD²·deficit)
    let prod = (lif as u128)
        .checked_mul(lltv_wad)
        .ok_or(ZoryaError::MathOverflow)?
        / WAD_U128;
    let denom_wad = WAD_U128
        .checked_sub(prod)
        .ok_or(ZoryaError::MathOverflow)?;

    let r_rcf = if denom_wad == 0 {
        debt
    } else {
        let deficit = (debt - max0) as u128;
        let raw = deficit
            .checked_mul(WAD_U128)
            .ok_or(ZoryaError::MathOverflow)?;
        let q = raw / denom_wad;
        let r = if raw % denom_wad == 0 { q } else { q + 1 };
        let needed = u64::try_from(r).map_err(|_| error!(ZoryaError::MathOverflow))?;
        needed.min(debt)
    };

    let seized = seized_collateral_atoms(r_rcf, lif, conservative, collateral_decimals)?;
    let leftover_coll = collateral.saturating_sub(seized.min(collateral));
    let leftover_debt = debt.saturating_sub(r_rcf);
    if leftover_coll < dust_collateral_atoms(collateral_decimals) || leftover_debt < dust_debt {
        return Ok(debt);
    }
    Ok(r_rcf)
}

/// Socialize `shortfall` against outstanding face. Claims keep their units;
/// redeem applies the new factor. Saturates at WAD.
pub fn next_loss_factor(current_lf: u64, total_credit: u64, shortfall: u64) -> Result<u64> {
    if total_credit == 0 || shortfall == 0 {
        return Ok(current_lf);
    }
    let shortfall = shortfall.min(total_credit);
    let unimpaired = (total_credit as u128)
        .checked_mul((WAD - current_lf) as u128)
        .ok_or(ZoryaError::MathOverflow)?
        / WAD_U128;
    let unimpaired_new = unimpaired.saturating_sub(shortfall as u128);
    let value = unimpaired_new
        .checked_mul(WAD_U128)
        .ok_or(ZoryaError::MathOverflow)?
        / total_credit as u128;
    let lf = WAD_U128.saturating_sub(value);
    u64::try_from(lf.min(WAD_U128)).map_err(|_| error!(ZoryaError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::market::DEFAULT_LIQ_CURSOR_BPS;

    #[test]
    fn max_lif_mvp_params() {
        let lif = max_lif_wad(7_000, DEFAULT_LIQ_CURSOR_BPS).unwrap();
        // 1 / 0.91 ≈ 1.098901098901098901
        assert_eq!(lif, 1_098_901_098_901_098_901);
    }

    #[test]
    fn default_ramp_starts_near_par() {
        let max = max_lif_wad(7_000, 3_000).unwrap();
        let t0 = 1_000_000i64;
        let just_after = default_lif_wad(t0 + 1, t0, max).unwrap();
        assert!(just_after > WAD);
        assert!(just_after < WAD + (max - WAD) / 1_000);
        let matured = default_lif_wad(t0 + GRACE_SECONDS, t0, max).unwrap();
        assert_eq!(matured, max);
        assert!(default_lif_wad(t0, t0, max).is_err());
    }

    #[test]
    fn seize_one_hundred_usdc_at_200() {
        let lif = max_lif_wad(7_000, 3_000).unwrap();
        // $100, $200/SOL, 9 dp → 0.5 SOL * ~1.0989 ≈ 0.54945 SOL
        let seized = seized_collateral_atoms(100_000_000, lif, 200_000_000, 9).unwrap();
        assert_eq!(seized, 549_450_549);
    }

    #[test]
    fn rcf_is_below_full_debt() {
        let cap = health_repay_cap(
            1_500_000_000,
            10_000_000_000,
            9,
            200_000_000,
            0,
            7_000,
            3_000,
            1_000_000,
        )
        .unwrap();
        // max_debt = 1.4e9, deficit 1e8, denom ≈ 0.2308 → ~433e6
        assert!(cap < 1_500_000_000);
        assert!(cap > 400_000_000);
        assert!(cap < 500_000_000);
    }

    #[test]
    fn first_shortfall_is_pro_rata() {
        let lf = next_loss_factor(0, 1_000_000, 100_000).unwrap();
        assert_eq!(lf, WAD / 10);
    }

    #[test]
    fn second_shortfall_compounds() {
        let lf1 = next_loss_factor(0, 1_000_000, 100_000).unwrap();
        let lf2 = next_loss_factor(lf1, 1_000_000, 90_000).unwrap();
        // 10% then 10% of remaining face → 19%
        assert_eq!(lf2, 190_000_000_000_000_000);
    }
}
