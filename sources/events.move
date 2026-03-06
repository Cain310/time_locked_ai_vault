module time_locked_vault::events;

// ═══════════════════════════════════════════════════════
// EVENTS — For off-chain indexing and AI agent trade history
//
// IMPORTANT: In Sui Move, `event::emit()` requires the type
// being emitted to be defined in the SAME module where emit()
// is called. Therefore, this module defines all event structs
// AND provides public `emit_*` functions that other modules call.
// ═══════════════════════════════════════════════════════

use sui::event;

// ═══════════════════════════════════════════════════════
// EVENT STRUCT DEFINITIONS
// All have `copy + drop` — ephemeral data, no identity.
// ═══════════════════════════════════════════════════════

/// Emitted when a new vault is created via `create_vault_and_share`
public struct VaultCreated has copy, drop {
    vault_id: ID,
    owner: address,
    max_slippage_bps: u64,
}

/// Emitted when a DelegatedTradingCap is minted and transferred to a delegate
public struct DelegationMinted has copy, drop {
    cap_id: ID,
    vault_id: ID,
    delegate: address,
    expiration_epoch: u64,
    trade_volume_limit: u64,
    max_trade_size: u64,
}

/// Emitted when a trade is executed by an AI agent via DeepBook
public struct TradeExecuted has copy, drop {
    vault_id: ID,
    cap_id: ID,
    /// true = base→quote, false = quote→base
    is_base_to_quote: bool,
    amount_in: u64,
    amount_out: u64,
    remaining_volume: u64,
    epoch: u64,
}

/// Emitted when all delegations are revoked via version bump
public struct AllDelegationsRevoked has copy, drop {
    vault_id: ID,
    new_version: u64,
}

/// Emitted on any deposit or withdrawal
public struct BalanceChanged has copy, drop {
    vault_id: ID,
    /// TypeName string of the asset (e.g., "0x2::sui::SUI")
    asset_type: vector<u8>,
    amount: u64,
    is_deposit: bool,
}

/// Emitted when trading is enabled or disabled by the owner
public struct TradingStatusChanged has copy, drop {
    vault_id: ID,
    enabled: bool,
}

// ═══════════════════════════════════════════════════════
// PUBLIC EMIT FUNCTIONS
//
// Sui Move requires `event::emit()` to be called from the
// same module that defines the event struct. These functions
// serve as the bridge — other modules call these instead
// of directly calling event::emit().
// ═══════════════════════════════════════════════════════

public fun emit_vault_created(
    vault_id: ID,
    owner: address,
    max_slippage_bps: u64,
) {
    event::emit(VaultCreated { vault_id, owner, max_slippage_bps });
}

public fun emit_delegation_minted(
    cap_id: ID,
    vault_id: ID,
    delegate: address,
    expiration_epoch: u64,
    trade_volume_limit: u64,
    max_trade_size: u64,
) {
    event::emit(DelegationMinted {
        cap_id,
        vault_id,
        delegate,
        expiration_epoch,
        trade_volume_limit,
        max_trade_size,
    });
}

public fun emit_trade_executed(
    vault_id: ID,
    cap_id: ID,
    is_base_to_quote: bool,
    amount_in: u64,
    amount_out: u64,
    remaining_volume: u64,
    epoch: u64,
) {
    event::emit(TradeExecuted {
        vault_id,
        cap_id,
        is_base_to_quote,
        amount_in,
        amount_out,
        remaining_volume,
        epoch,
    });
}

public fun emit_all_delegations_revoked(
    vault_id: ID,
    new_version: u64,
) {
    event::emit(AllDelegationsRevoked { vault_id, new_version });
}

public fun emit_balance_changed(
    vault_id: ID,
    asset_type: vector<u8>,
    amount: u64,
    is_deposit: bool,
) {
    event::emit(BalanceChanged { vault_id, asset_type, amount, is_deposit });
}

public fun emit_trading_status_changed(
    vault_id: ID,
    enabled: bool,
) {
    event::emit(TradingStatusChanged { vault_id, enabled });
}
