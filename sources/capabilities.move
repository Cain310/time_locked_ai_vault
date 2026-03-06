module time_locked_vault::capabilities;

// ═══════════════════════════════════════════════════════
// IMPORTS
// ═══════════════════════════════════════════════════════

// Cross-module references
use time_locked_vault::vault::{Self, Vault, OwnerCap};
use time_locked_vault::events;

// ═══════════════════════════════════════════════════════
// ERROR CONSTANTS
// ═══════════════════════════════════════════════════════

/// OwnerCap.vault_id does not match the Vault being delegated
const EInvalidOwnerCap: u64 = 0;
/// Expiration epoch must be in the future
const EInvalidExpiration: u64 = 1;
/// Cannot destroy a cap that is still active (not expired, not exhausted, not revoked)
const ECapStillActive: u64 = 2;

// ═══════════════════════════════════════════════════════
// STRUCT DEFINITIONS
// ═══════════════════════════════════════════════════════

/// Grants bounded trading authority over a specific Vault.
/// Minted by the vault owner and transferred to an AI agent address.
///
/// All constraints are embedded directly in the struct —
/// no additional storage lookups required at authentication time.
///
/// Abilities: `key + store` (transferable), NO `copy` (non-duplicable).
/// If `copy` were added, an attacker could clone infinite caps,
/// defeating all quota enforcement.
public struct DelegatedTradingCap has key, store {
    id: UID,
    /// The ID of the Vault this cap can trade on behalf of.
    vault_id: ID,
    /// The Sui epoch after which this cap becomes invalid.
    /// Checked via: cap.expiration_epoch > tx_context::epoch(ctx)
    expiration_epoch: u64,
    /// Remaining cumulative trade volume allowed (in base asset units).
    /// Decremented by trade_amount on each successful trade.
    remaining_trade_volume: u64,
    /// Maximum volume for a single trade execution.
    /// Prevents a rogue agent from using entire quota in one swap.
    max_trade_size: u64,
    /// Snapshot of Vault.version at mint time.
    /// Must match vault.version at authentication — if the owner
    /// has incremented the vault version, this cap is revoked.
    version: u64,
}

// ═══════════════════════════════════════════════════════
// PUBLIC FUNCTIONS
// ═══════════════════════════════════════════════════════

/// Mint a new DelegatedTradingCap and transfer it to the delegate address.
///
/// The cap snapshots `vault.version` at mint time — if the owner later
/// calls `revoke_all_delegations` (incrementing the version), this cap
/// becomes instantly invalid without any per-cap iteration.
#[allow(lint(self_transfer))]
public fun mint_delegated_trading_cap(
    vault: &Vault,
    owner_cap: &OwnerCap,
    delegate: address,
    expiration_epoch: u64,
    trade_volume_limit: u64,
    max_trade_size: u64,
    ctx: &mut TxContext,
) {
    // Validate owner controls this vault
    assert!(vault::owner_cap_vault_id(owner_cap) == object::id(vault), EInvalidOwnerCap);
    // Expiration must be in the future
    assert!(expiration_epoch > ctx.epoch(), EInvalidExpiration);

    let cap = DelegatedTradingCap {
        id: object::new(ctx),
        vault_id: object::id(vault),
        expiration_epoch,
        remaining_trade_volume: trade_volume_limit,
        max_trade_size,
        version: vault::version(vault), // Snapshot current vault version
    };

    // Emit event for off-chain tracking
    events::emit_delegation_minted(
        object::id(&cap),
        object::id(vault),
        delegate,
        expiration_epoch,
        trade_volume_limit,
        max_trade_size,
    );

    // Transfer to the delegate — they now possess the trading authority
    transfer::public_transfer(cap, delegate);
}

/// Destroy an inert DelegatedTradingCap and recover its storage rebate.
///
/// A cap is "inert" if ANY of these conditions is true:
///   - Expired: current epoch >= expiration_epoch
///   - Exhausted: remaining_trade_volume == 0
///   - Revoked: cap.version != vault.version
///
/// Can be called by anyone — the cap is useless anyway.
/// The storage rebate is returned to the transaction sender.
public fun destroy_inert_cap(
    vault: &Vault,
    cap: DelegatedTradingCap,
    ctx: &TxContext,
) {
    // Destructure the cap — this is how Move "consumes" a struct
    let DelegatedTradingCap {
        id,
        vault_id: _,
        expiration_epoch,
        remaining_trade_volume,
        max_trade_size: _,
        version,
    } = cap;

    // Must be actually inert — at least one invalidation condition must hold
    assert!(
        ctx.epoch() >= expiration_epoch ||
        remaining_trade_volume == 0 ||
        version != vault::version(vault),
        ECapStillActive,
    );

    // Delete the UID — reclaims storage and returns rebate to sender
    object::delete(id);
}

// ═══════════════════════════════════════════════════════
// PUBLIC ACCESSORS — for cross-module reads (trading.move)
// ═══════════════════════════════════════════════════════

/// Returns the vault_id this cap is linked to.
public fun cap_vault_id(cap: &DelegatedTradingCap): ID {
    cap.vault_id
}

/// Returns the epoch after which this cap expires.
public fun expiration_epoch(cap: &DelegatedTradingCap): u64 {
    cap.expiration_epoch
}

/// Returns the remaining cumulative trade volume allowed.
public fun remaining_trade_volume(cap: &DelegatedTradingCap): u64 {
    cap.remaining_trade_volume
}

/// Returns the maximum single trade size allowed.
public fun max_trade_size(cap: &DelegatedTradingCap): u64 {
    cap.max_trade_size
}

/// Returns the version snapshot from when this cap was minted.
public fun cap_version(cap: &DelegatedTradingCap): u64 {
    cap.version
}

// ═══════════════════════════════════════════════════════
// PUBLIC(PACKAGE) MUTATORS — for trading.move
// ═══════════════════════════════════════════════════════

/// Decrement the remaining trade volume after a successful trade.
/// Only callable within this package (by trading.move).
public(package) fun decrement_volume(cap: &mut DelegatedTradingCap, amount: u64) {
    cap.remaining_trade_volume = cap.remaining_trade_volume - amount;
}
