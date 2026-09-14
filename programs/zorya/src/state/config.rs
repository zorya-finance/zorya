use anchor_lang::prelude::*;

pub const MAX_LLTV_SLOTS: usize = 8;
pub const DEFAULT_LLTV_BPS: u16 = 7_000;
pub const BTC_LLTV_BPS: u16 = 6_500;

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub paused: bool,
    pub lltv_count: u8,
    pub allowed_lltv_bps: [u16; MAX_LLTV_SLOTS],
    pub bump: u8,
}

impl ProtocolConfig {
    pub fn allows_lltv(&self, lltv_bps: u16) -> bool {
        self.allowed_lltv_bps
            .iter()
            .take(self.lltv_count as usize)
            .any(|v| *v == lltv_bps)
    }
}
