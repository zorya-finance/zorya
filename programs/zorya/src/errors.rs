use anchor_lang::prelude::*;

#[error_code]
pub enum ZoryaError {
    #[msg("Config is already initialized")]
    ConfigAlreadyInitialized,
    #[msg("Signer is not the protocol authority")]
    Unauthorized,
    #[msg("Protocol is paused for this action")]
    Paused,
    #[msg("LLTV is not in the allowlist")]
    LltvNotAllowed,
    #[msg("Market parameters are invalid")]
    InvalidMarketParams,
    #[msg("Maturity is outside the allowed window")]
    InvalidMaturity,
    #[msg("Collateral mint and loan mint must differ")]
    MintsMustDiffer,
    #[msg("Market is not active for this action")]
    MarketNotActive,
    #[msg("Market is already at or past maturity")]
    MarketMatured,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Tick is outside the market grid")]
    InvalidTick,
    #[msg("Implied price is at or above par")]
    PriceAtOrAbovePar,
    #[msg("Fill is below the market minimum")]
    FillTooSmall,
    #[msg("Quote escrow cannot cover the fill")]
    InsufficientEscrow,
    #[msg("Position would be unhealthy")]
    Unhealthy,
    #[msg("Mock oracle price is unset or invalid")]
    InvalidOraclePrice,
    #[msg("Oracle confidence is too wide")]
    OracleConfidenceTooWide,
    #[msg("Oracle price is stale or from the future")]
    OraclePriceStale,
    #[msg("Oracle feed id does not match the market")]
    OracleFeedMismatch,
    #[msg("Insufficient collateral")]
    InsufficientCollateral,
    #[msg("Insufficient debt to repay")]
    InsufficientDebt,
    #[msg("Token mint mismatch")]
    MintMismatch,
    #[msg("Maker cannot fill their own quote")]
    SelfTrade,
    #[msg("Curve has no remaining tenor slots")]
    CurveFull,
    #[msg("Curve pair does not match this market")]
    CurvePairMismatch,
    #[msg("Curve has no tenor slot for this market maturity")]
    CurveTenorMissing,
    #[msg("Market has not reached maturity")]
    MarketNotMatured,
    #[msg("Market loan vault has no cash for this redeem")]
    InsufficientVault,
    #[msg("Claim has insufficient credit")]
    InsufficientCredit,
    #[msg("Position is healthy and cannot be health-liquidated")]
    HealthyPosition,
    #[msg("Market is not past maturity for default liquidation")]
    NotPastMaturity,
    #[msg("Repay exceeds the recovery close factor")]
    OverLiquidation,
    #[msg("No debt to liquidate")]
    NoDebt,
    #[msg("Price update is not owned by the market oracle program")]
    OracleOwnerMismatch,
    #[msg("Pyth price update is not fully verified")]
    OracleNotFullyVerified,
}
