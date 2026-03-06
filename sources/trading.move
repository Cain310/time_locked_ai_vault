module time_locked_vault::trading;

// ═══════════════════════════════════════════════════════
// IMPORTS
// ═══════════════════════════════════════════════════════

// Asset management
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};

// Dynamic Field access (for extract/deposit coin)
use sui::dynamic_field;
use std::type_name::{Self, TypeName};

// Clock for time-based checks
use sui::clock::Clock;

// DeepBook V3
use deepbook::pool::{Self, Pool};
use token::deep::DEEP;

// Internal modules
use time_locked_vault::vault::{Self, Vault};
use time_locked_vault::capabilities::{Self, DelegatedTradingCap};
use time_locked_vault::events;

// ═══════════════════════════════════════════════════════
// ERROR CONSTANTS
// ═══════════════════════════════════════════════════════

/// Cap has expired — current epoch >= expiration_epoch
const ECapExpired: u64 = 0;
/// Cumulative trade volume quota exceeded
const EQuotaExceeded: u64 = 1;
/// Cap version doesn't match vault version — cap has been revoked
const ECapRevoked: u64 = 2;
/// Cap's vault_id doesn't match the provided vault
const EInvalidVault: u64 = 3;
/// Single trade exceeds the per-trade size ceiling
const ETradeTooLarge: u64 = 4;
/// Trading has been disabled by the vault owner
const ETradingDisabled: u64 = 5;
/// Vault doesn't have enough balance of the requested token type
const EInsufficientBalance: u64 = 6;
/// Agent-specified slippage exceeds vault's maximum tolerance
const ESlippageExceeded: u64 = 7;

// ═══════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════

/// Default DEEP fee estimate for swaps (0.5 DEEP = 500_000_000 MIST-equivalent)
/// DeepBook returns any unused DEEP, so overestimating is safe.
const DEFAULT_DEEP_FEE: u64 = 500_000_000;

// ═══════════════════════════════════════════════════════
// PUBLIC SWAP FUNCTIONS
// ═══════════════════════════════════════════════════════

/// Execute a base-to-quote swap using delegated authority.
/// This is the primary function called by the AI agent's PTB.
///
/// Flow: authenticate → extract coins → DeepBook swap → deposit results → emit event
public fun execute_swap_base_to_quote<BaseAsset, QuoteAsset>(
    vault: &mut Vault,
    cap: &mut DelegatedTradingCap,
    pool: &mut Pool<BaseAsset, QuoteAsset>,
    trade_amount: u64,
    min_quote_out: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // ── PHASE 1: Authentication (6 assertions) ──
    authenticate_trade(vault, cap, trade_amount, clock, ctx);

    // ── PHASE 2: Validate slippage ──
    // Note: slippage validation is handled by DeepBook's min_quote_out parameter
    // and our vault-level max_slippage_bps check would require an oracle price.
    // For now, we trust the agent's min_quote_out and DeepBook enforces it.

    // ── PHASE 3: Extract coins from vault dynamic fields ──
    let base_coin = extract_coin<BaseAsset>(vault, trade_amount, ctx);
    let deep_coin = extract_coin<DEEP>(vault, DEFAULT_DEEP_FEE, ctx);

    // ── PHASE 4: Execute DeepBook V3 swap ──
    let (base_leftover, quote_received, deep_leftover) =
        pool::swap_exact_base_for_quote(
            pool,
            base_coin,
            deep_coin,
            min_quote_out,
            clock,
            ctx,
        );

    // Capture output amount before depositing (for the event)
    let quote_amount = coin::value(&quote_received);

    // ── PHASE 5: Deposit all results back into vault ──
    deposit_coin<BaseAsset>(vault, base_leftover);
    deposit_coin<QuoteAsset>(vault, quote_received);
    deposit_coin<DEEP>(vault, deep_leftover);

    // ── PHASE 6: Emit trade event ──
    events::emit_trade_executed(
        object::id(vault),
        object::id(cap),
        true, // is_base_to_quote
        trade_amount,
        quote_amount,
        capabilities::remaining_trade_volume(cap),
        ctx.epoch(),
    );
}

/// Execute a quote-to-base swap using delegated authority.
/// Mirror of execute_swap_base_to_quote for the reverse direction.
public fun execute_swap_quote_to_base<BaseAsset, QuoteAsset>(
    vault: &mut Vault,
    cap: &mut DelegatedTradingCap,
    pool: &mut Pool<BaseAsset, QuoteAsset>,
    trade_amount: u64,
    min_base_out: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // ── PHASE 1: Authentication (6 assertions) ──
    authenticate_trade(vault, cap, trade_amount, clock, ctx);

    // ── PHASE 2: Extract coins from vault dynamic fields ──
    let quote_coin = extract_coin<QuoteAsset>(vault, trade_amount, ctx);
    let deep_coin = extract_coin<DEEP>(vault, DEFAULT_DEEP_FEE, ctx);

    // ── PHASE 3: Execute DeepBook V3 swap ──
    let (base_received, quote_leftover, deep_leftover) =
        pool::swap_exact_quote_for_base(
            pool,
            quote_coin,
            deep_coin,
            min_base_out,
            clock,
            ctx,
        );

    // Capture output amount before depositing (for the event)
    let base_amount = coin::value(&base_received);

    // ── PHASE 4: Deposit all results back into vault ──
    deposit_coin<BaseAsset>(vault, base_received);
    deposit_coin<QuoteAsset>(vault, quote_leftover);
    deposit_coin<DEEP>(vault, deep_leftover);

    // ── PHASE 5: Emit trade event ──
    events::emit_trade_executed(
        object::id(vault),
        object::id(cap),
        false, // is_base_to_quote = false → quote-to-base
        trade_amount,
        base_amount,
        capabilities::remaining_trade_volume(cap),
        ctx.epoch(),
    );
}

// ═══════════════════════════════════════════════════════
// PRIVATE FUNCTIONS — internal to this module
// ═══════════════════════════════════════════════════════

/// The security heart of the system.
/// Validates the DelegatedTradingCap against the Vault state.
/// Decrements remaining_trade_volume on success.
/// Aborts with a specific error code on any violation.
///
/// Assertions are ordered from cheapest to most informative:
///   1. Vault ID match (catches wrong inputs)
///   2. Trading enabled (catches emergency shutdown)
///   3. Version match (catches revoked caps)
///   4. Epoch expiration (catches expired caps)
///   5. Per-trade size limit (catches oversized trades)
///   6. Cumulative quota (catches exhausted caps)
public(package) fun authenticate_trade(
    vault: &Vault,
    cap: &mut DelegatedTradingCap,
    trade_amount: u64,
    _clock: &Clock,
    ctx: &TxContext,
) {
    // ── CHECK 1: Vault ID match ──
    assert!(capabilities::cap_vault_id(cap) == object::id(vault), EInvalidVault);

    // ── CHECK 2: Trading globally enabled ──
    assert!(vault::trading_enabled(vault), ETradingDisabled);

    // ── CHECK 3: Version match (revocation check) ──
    assert!(capabilities::cap_version(cap) == vault::version(vault), ECapRevoked);

    // ── CHECK 4: Epoch expiration ──
    assert!(capabilities::expiration_epoch(cap) > ctx.epoch(), ECapExpired);

    // ── CHECK 5: Per-trade size limit ──
    assert!(trade_amount <= capabilities::max_trade_size(cap), ETradeTooLarge);

    // ── CHECK 6: Cumulative quota remaining ──
    assert!(capabilities::remaining_trade_volume(cap) >= trade_amount, EQuotaExceeded);

    // ── DECREMENT quota via package-internal mutator ──
    capabilities::decrement_volume(cap, trade_amount);
}

/// Extract a Coin<T> from the vault's dynamic field Balance<T>.
/// Uses vault::uid_mut() (public(package)) to access the vault's UID.
fun extract_coin<T>(
    vault: &mut Vault,
    amount: u64,
    ctx: &mut TxContext,
): Coin<T> {
    let key = type_name::with_defining_ids<T>();
    let uid = vault::uid_mut(vault);

    assert!(dynamic_field::exists_(uid, key), EInsufficientBalance);

    let balance_mut = dynamic_field::borrow_mut<TypeName, Balance<T>>(
        uid, key,
    );
    assert!(balance::value(balance_mut) >= amount, EInsufficientBalance);

    coin::take(balance_mut, amount, ctx)
}

/// Deposit a Coin<T> back into the vault's dynamic field Balance<T>.
/// Handles zero-value coins by destroying them (gas optimization).
fun deposit_coin<T>(
    vault: &mut Vault,
    coin: Coin<T>,
) {
    // Zero-value coin optimization — destroy rather than store
    if (coin::value(&coin) == 0) {
        coin::destroy_zero(coin);
        return
    };

    let key = type_name::with_defining_ids<T>();
    let uid = vault::uid_mut(vault);

    if (dynamic_field::exists_(uid, key)) {
        let balance_mut = dynamic_field::borrow_mut<TypeName, Balance<T>>(
            uid, key,
        );
        balance::join(balance_mut, coin::into_balance(coin));
    } else {
        // First time this asset type enters the vault via trading
        dynamic_field::add(uid, key, coin::into_balance(coin));
    };
}

/// Validate that agent-specified slippage doesn't exceed vault maximum.
/// Currently unused — slippage is enforced by DeepBook's min_out parameter.
/// Kept as a utility for future oracle-based slippage validation.
#[allow(unused_function)]
fun validate_slippage(
    vault: &Vault,
    expected_out: u64,
    min_out: u64,
) {
    // Calculate implied slippage in basis points
    // slippage_bps = ((expected_out - min_out) * 10000) / expected_out
    if (expected_out > 0) {
        let slippage_bps = ((expected_out - min_out) * 10000) / expected_out;
        assert!(slippage_bps <= vault::max_slippage_bps(vault), ESlippageExceeded);
    };
}
