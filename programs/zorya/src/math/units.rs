use crate::errors::ZoryaError;
use anchor_lang::prelude::*;

pub const WAD: u64 = 1_000_000_000_000_000_000;
pub const WAD_U128: u128 = WAD as u128;

pub fn floor_mul_wad(amount: u64, price_wad: u64) -> Result<u64> {
    let raw = (amount as u128)
        .checked_mul(price_wad as u128)
        .ok_or(ZoryaError::MathOverflow)?;
    u64::try_from(raw / WAD_U128).map_err(|_| error!(ZoryaError::MathOverflow))
}

pub fn ceil_mul_wad(amount: u64, price_wad: u64) -> Result<u64> {
    let raw = (amount as u128)
        .checked_mul(price_wad as u128)
        .ok_or(ZoryaError::MathOverflow)?;
    let q = raw / WAD_U128;
    let r = raw % WAD_U128;
    let out = if r == 0 { q } else { q.checked_add(1).ok_or(ZoryaError::MathOverflow)? };
    u64::try_from(out).map_err(|_| error!(ZoryaError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_rounds_toward_zero() {
        assert_eq!(floor_mul_wad(1_000_000, WAD / 2).unwrap(), 500_000);
        assert_eq!(floor_mul_wad(3, WAD / 2).unwrap(), 1);
    }

    #[test]
    fn ceil_rounds_away_from_zero() {
        assert_eq!(ceil_mul_wad(3, WAD / 2).unwrap(), 2);
        assert_eq!(ceil_mul_wad(2, WAD / 2).unwrap(), 1);
    }
}
