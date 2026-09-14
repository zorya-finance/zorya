//! Host fuzz for settlement math. Sprint 4.
//!
//! Instruction-level adversarial cases live in `tests/attacks.ts` on localnet.
//! This module hammers ticks, health, LIF, and `loss_factor` without a validator.

use crate::math::health::{conservative_price_e6, is_healthy, max_debt_units};
use crate::math::liquidation::{
    default_lif_wad, health_repay_cap, max_lif_wad, next_loss_factor, seized_collateral_atoms,
};
use crate::math::oracle::{parse_price_update_v2, validate_pyth_quote};
use crate::math::ticks::tick_to_price_wad;
use crate::math::units::{ceil_mul_wad, floor_mul_wad, WAD, WAD_U128};
use crate::state::market::{GRACE_SECONDS, TICK_N};
use proptest::prelude::*;

fn cfg() -> ProptestConfig {
    ProptestConfig {
        cases: 64,
        ..ProptestConfig::default()
    }
}

proptest! {
    #![proptest_config(cfg())]

    #[test]
    fn tick_price_is_in_open_unit_interval(tick in 0i32..=TICK_N, delta in 50u16..=400u16) {
        let p = tick_to_price_wad(tick, delta).unwrap();
        prop_assert!(p > 0);
        prop_assert!(p < WAD);
    }

    #[test]
    fn higher_tick_is_a_higher_price(tick in 0i32..TICK_N, delta in 50u16..=400u16) {
        let low = tick_to_price_wad(tick, delta).unwrap();
        let high = tick_to_price_wad(tick + 1, delta).unwrap();
        prop_assert!(high > low);
    }

    #[test]
    fn floor_never_exceeds_ceil(amount in 1u64..=1_000_000_000, tick in 0i32..=TICK_N) {
        let price = tick_to_price_wad(tick, 200).unwrap();
        let floor = floor_mul_wad(amount, price).unwrap();
        let ceil = ceil_mul_wad(amount, price).unwrap();
        prop_assert!(floor <= ceil);
        prop_assert!(ceil <= amount);
    }

    #[test]
    fn max_debt_grows_with_collateral(
        coll_a in 1u64..=5_000_000_000,
        extra in 1u64..=5_000_000_000,
        price_e6 in 1_000_000u64..=500_000_000,
        lltv in prop::sample::select(vec![6_500u16, 7_000]),
    ) {
        let a = max_debt_units(coll_a, 9, price_e6, 0, lltv).unwrap();
        let b = max_debt_units(coll_a.saturating_add(extra), 9, price_e6, 0, lltv).unwrap();
        prop_assert!(b >= a);
    }

    #[test]
    fn wide_confidence_is_rejected(price_e6 in 10_000u64..=200_000_000) {
        let too_wide = (price_e6 / 100) * 3 + 1; // > 2%
        prop_assert!(conservative_price_e6(price_e6, too_wide).is_err());
        prop_assert!(conservative_price_e6(price_e6, 0).is_ok());
    }

    #[test]
    fn healthy_below_or_at_cap(
        coll in 1_000_000_000u64..=20_000_000_000,
        price_e6 in 50_000_000u64..=300_000_000,
    ) {
        let quote = crate::math::oracle::OracleQuote { price_e6, conf_e6: 0 };
        let max = max_debt_units(coll, 9, price_e6, 0, 7_000).unwrap();
        prop_assert!(is_healthy(max, coll, 9, &quote, 7_000).unwrap());
        if max < u64::MAX {
            prop_assert!(!is_healthy(max.saturating_add(1), coll, 9, &quote, 7_000).unwrap());
        }
    }

    #[test]
    fn loss_factor_is_monotone_and_capped(
        credit in 1_000_000u64..=1_000_000_000,
        first in 1u64..=400_000,
        second in 1u64..=400_000,
    ) {
        let lf1 = next_loss_factor(0, credit, first.min(credit)).unwrap();
        let lf2 = next_loss_factor(lf1, credit, second.min(credit)).unwrap();
        prop_assert!(lf1 <= WAD);
        prop_assert!(lf2 <= WAD);
        prop_assert!(lf2 >= lf1);
    }

    #[test]
    fn default_lif_ramps_inside_bounds(elapsed in 1i64..=GRACE_SECONDS) {
        let max = max_lif_wad(7_000, 3_000).unwrap();
        let t0 = 1_700_000_000i64;
        let lif = default_lif_wad(t0 + elapsed, t0, max).unwrap();
        prop_assert!(lif >= WAD);
        prop_assert!(lif <= max);
        if elapsed == GRACE_SECONDS {
            prop_assert_eq!(lif, max);
        }
    }

    #[test]
    fn health_repay_cap_never_exceeds_debt(
        extra_debt in 10_000_000u64..=800_000_000,
    ) {
        let coll = 10_000_000_000u64;
        let price = 200_000_000u64;
        let max0 = max_debt_units(coll, 9, price, 0, 7_000).unwrap();
        let debt = max0.saturating_add(extra_debt);
        let cap = health_repay_cap(debt, coll, 9, price, 0, 7_000, 3_000, 1_000_000).unwrap();
        prop_assert!(cap <= debt);
        prop_assert!(cap > 0);
    }

    #[test]
    fn seize_is_zero_when_repaid_is_zero(price_e6 in 1_000_000u64..=400_000_000) {
        let lif = max_lif_wad(7_000, 3_000).unwrap();
        let seized = seized_collateral_atoms(0, lif, price_e6, 9).unwrap();
        prop_assert_eq!(seized, 0);
    }

    #[test]
    fn pyth_stale_and_feed_mismatch_revert(
        age in 31i64..=10_000,
        publish in 1i64..=1_000_000,
    ) {
        let feed = [7u8; 32];
        let other = [8u8; 32];
        prop_assert!(validate_pyth_quote(
            20_000_000_000, 0, -8, publish, publish + age, &feed, &feed, 6
        )
        .is_err());
        prop_assert!(validate_pyth_quote(
            20_000_000_000, 0, -8, publish, publish, &other, &feed, 6
        )
        .is_err());
    }

    #[test]
    fn redeem_payout_never_exceeds_unimpaired_face(
        units in 1u64..=1_000_000_000,
        loss in 0u64..=WAD,
    ) {
        let value = WAD.saturating_sub(loss);
        let payout = floor_mul_wad(units, value).unwrap();
        prop_assert!(payout <= units);
        if loss == 0 {
            prop_assert_eq!(payout, units);
        }
        if loss == WAD {
            prop_assert_eq!(payout, 0);
        }
    }

    #[test]
    fn pyth_future_publish_time_reverts(skew in 1i64..=10_000) {
        let feed = [7u8; 32];
        let now = 1_000_000i64;
        prop_assert!(validate_pyth_quote(
            20_000_000_000, 0, -8, now + skew, now, &feed, &feed, 6
        )
        .is_err());
    }

    #[test]
    fn parse_price_update_never_panics(bytes in prop::collection::vec(any::<u8>(), 0..200)) {
        let _ = parse_price_update_v2(&bytes);
    }
}

#[test]
fn wad_constants_match() {
    assert_eq!(WAD as u128, WAD_U128);
}
