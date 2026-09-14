use anchor_lang::prelude::*;

pub const ORACLE_KIND_MOCK: u8 = 0;
pub const ORACLE_KIND_PYTH: u8 = 1;
pub const TICK_N: i32 = 512;
pub const DEFAULT_TICK_DELTA_BPS: u16 = 200;
pub const DEFAULT_LIQ_CURSOR_BPS: u16 = 3_000;
/// Post-maturity LIF ramp. Q6 SAFE DEFAULT.
pub const GRACE_SECONDS: i64 = 21_600;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum MarketStatus {
    Pending,
    Active,
    Matured,
    Retired,
}

#[account]
#[derive(InitSpace)]
pub struct TermMarket {
    pub collateral_mint: Pubkey,
    pub loan_mint: Pubkey,
    pub oracle_program: Pubkey,
    pub oracle_feed_id: [u8; 32],
    pub lltv_bps: u16,
    pub liquidation_cursor_bps: u16,
    pub maturity_ts: i64,
    pub tick_delta_bps: u16,
    pub min_fill_units: u64,
    pub status: MarketStatus,
    pub total_credit_units: u64,
    pub total_debt_units: u64,
    pub loss_factor_wad: u64,
    /// Layout only. Always 0 at MVP — must not be read as an active fee.
    pub settlement_fee_bps: u16,
    pub oracle_kind: u8,
    pub collateral_decimals: u8,
    pub loan_decimals: u8,
    pub loan_vault_bump: u8,
    pub collateral_vault_bump: u8,
    pub bump: u8,
}

impl TermMarket {
    pub fn is_matured(&self, now: i64) -> bool {
        now >= self.maturity_ts
    }

    pub fn sync_status(&mut self, now: i64) {
        if self.status == MarketStatus::Active && now >= self.maturity_ts {
            self.status = MarketStatus::Matured;
        }
    }
}

impl Curve {
    pub fn upsert_tenor(
        &mut self,
        pair_collateral: Pubkey,
        pair_loan: Pubkey,
        maturity_ts: i64,
        bump: u8,
    ) -> Result<()> {
        if self.tenor_count == 0 {
            self.pair_collateral = pair_collateral;
            self.pair_loan = pair_loan;
            self.bump = bump;
            self.maturity_ts[0] = maturity_ts;
            self.tenor_count = 1;
            return Ok(());
        }
        require!(
            self.pair_collateral == pair_collateral && self.pair_loan == pair_loan,
            crate::errors::ZoryaError::CurvePairMismatch
        );
        let exists = (0..self.tenor_count as usize).any(|i| self.maturity_ts[i] == maturity_ts);
        if exists {
            return Ok(());
        }
        require!(
            (self.tenor_count as usize) < self.maturity_ts.len(),
            crate::errors::ZoryaError::CurveFull
        );
        let n = self.tenor_count as usize;
        let mut insert = n;
        for i in 0..n {
            if self.maturity_ts[i] > maturity_ts {
                insert = i;
                break;
            }
        }
        for i in (insert..n).rev() {
            self.maturity_ts[i + 1] = self.maturity_ts[i];
            self.last_price_wad[i + 1] = self.last_price_wad[i];
            self.last_fill_ts[i + 1] = self.last_fill_ts[i];
            self.cumulative_units[i + 1] = self.cumulative_units[i];
        }
        self.maturity_ts[insert] = maturity_ts;
        self.last_price_wad[insert] = 0;
        self.last_fill_ts[insert] = 0;
        self.cumulative_units[insert] = 0;
        self.tenor_count = n as u8 + 1;
        Ok(())
    }

    pub fn record_fill(
        &mut self,
        maturity_ts: i64,
        price_wad: u64,
        units: u64,
        now: i64,
    ) -> Result<()> {
        let slot = (0..self.tenor_count as usize)
            .find(|&i| self.maturity_ts[i] == maturity_ts)
            .ok_or(crate::errors::ZoryaError::CurveTenorMissing)?;
        self.last_price_wad[slot] = price_wad;
        self.last_fill_ts[slot] = now;
        self.cumulative_units[slot] = self.cumulative_units[slot]
            .checked_add(units)
            .ok_or(crate::errors::ZoryaError::MathOverflow)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::prelude::Pubkey;

    #[test]
    fn upsert_appends_distinct_tenors() {
        let mut curve = Curve {
            pair_collateral: Pubkey::new_unique(),
            pair_loan: Pubkey::new_unique(),
            tenor_count: 0,
            maturity_ts: [0; 8],
            last_price_wad: [0; 8],
            last_fill_ts: [0; 8],
            cumulative_units: [0; 8],
            bump: 1,
        };
        let c = curve.pair_collateral;
        let l = curve.pair_loan;
        curve.upsert_tenor(c, l, 100, 1).unwrap();
        curve.upsert_tenor(c, l, 200, 1).unwrap();
        curve.upsert_tenor(c, l, 100, 1).unwrap();
        assert_eq!(curve.tenor_count, 2);
        assert_eq!(curve.maturity_ts[0], 100);
        assert_eq!(curve.maturity_ts[1], 200);
    }

    #[test]
    fn upsert_keeps_tenors_sorted() {
        let mut curve = Curve {
            pair_collateral: Pubkey::new_unique(),
            pair_loan: Pubkey::new_unique(),
            tenor_count: 0,
            maturity_ts: [0; 8],
            last_price_wad: [0; 8],
            last_fill_ts: [0; 8],
            cumulative_units: [0; 8],
            bump: 1,
        };
        let c = curve.pair_collateral;
        let l = curve.pair_loan;
        curve.upsert_tenor(c, l, 300, 1).unwrap();
        curve.record_fill(300, 5, 10, 9).unwrap();
        curve.upsert_tenor(c, l, 100, 1).unwrap();
        curve.upsert_tenor(c, l, 200, 1).unwrap();
        assert_eq!(curve.tenor_count, 3);
        assert_eq!(curve.maturity_ts[0], 100);
        assert_eq!(curve.maturity_ts[1], 200);
        assert_eq!(curve.maturity_ts[2], 300);
        assert_eq!(curve.last_price_wad[2], 5);
        assert_eq!(curve.cumulative_units[2], 10);
        assert_eq!(curve.last_price_wad[0], 0);
    }

    fn blank() -> Curve {
        Curve {
            pair_collateral: Pubkey::new_unique(),
            pair_loan: Pubkey::new_unique(),
            tenor_count: 0,
            maturity_ts: [0; 8],
            last_price_wad: [0; 8],
            last_fill_ts: [0; 8],
            cumulative_units: [0; 8],
            bump: 1,
        }
    }

    #[test]
    fn upsert_rejects_a_foreign_pair() {
        let mut curve = blank();
        let c = curve.pair_collateral;
        let l = curve.pair_loan;
        curve.upsert_tenor(c, l, 100, 1).unwrap();
        let err = curve
            .upsert_tenor(Pubkey::new_unique(), l, 200, 1)
            .unwrap_err();
        assert_eq!(err, crate::errors::ZoryaError::CurvePairMismatch.into());
    }

    #[test]
    fn upsert_rejects_a_ninth_tenor() {
        let mut curve = blank();
        let c = curve.pair_collateral;
        let l = curve.pair_loan;
        for i in 0..8 {
            curve.upsert_tenor(c, l, 100 + i, 1).unwrap();
        }
        let err = curve.upsert_tenor(c, l, 200, 1).unwrap_err();
        assert_eq!(err, crate::errors::ZoryaError::CurveFull.into());
        assert_eq!(curve.tenor_count, 8);
    }

    #[test]
    fn record_fill_rejects_an_unknown_maturity() {
        let mut curve = blank();
        let c = curve.pair_collateral;
        let l = curve.pair_loan;
        curve.upsert_tenor(c, l, 100, 1).unwrap();
        let err = curve.record_fill(999, 1, 1, 1).unwrap_err();
        assert_eq!(err, crate::errors::ZoryaError::CurveTenorMissing.into());
    }

    #[test]
    fn record_fill_accumulates_volume_and_overwrites_the_print() {
        let mut curve = blank();
        let c = curve.pair_collateral;
        let l = curve.pair_loan;
        curve.upsert_tenor(c, l, 100, 1).unwrap();
        curve.record_fill(100, 5, 10, 1).unwrap();
        curve.record_fill(100, 7, 3, 2).unwrap();
        assert_eq!(curve.last_price_wad[0], 7);
        assert_eq!(curve.last_fill_ts[0], 2);
        assert_eq!(curve.cumulative_units[0], 13);
    }

    #[test]
    fn record_fill_rejects_volume_overflow() {
        let mut curve = blank();
        let c = curve.pair_collateral;
        let l = curve.pair_loan;
        curve.upsert_tenor(c, l, 100, 1).unwrap();
        curve.record_fill(100, 1, u64::MAX, 1).unwrap();
        let err = curve.record_fill(100, 1, 1, 2).unwrap_err();
        assert_eq!(err, crate::errors::ZoryaError::MathOverflow.into());
    }
}

#[account]
#[derive(InitSpace)]
pub struct Curve {
    pub pair_collateral: Pubkey,
    pub pair_loan: Pubkey,
    pub tenor_count: u8,
    pub maturity_ts: [i64; 8],
    pub last_price_wad: [u64; 8],
    pub last_fill_ts: [i64; 8],
    pub cumulative_units: [u64; 8],
    pub bump: u8,
}
