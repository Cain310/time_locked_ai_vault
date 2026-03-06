module time_locked_vault::vault;

// ═══════════════════════════════════════════════════════
// IMPORTS
// ═══════════════════════════════════════════════════════

// Asset management
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};

// Multi-asset Dynamic Field support
use sui::dynamic_field;
use std::type_name::{Self, TypeName};

// Internal events module — provides emit_* functions
use time_locked_vault::events;

// ═══════════════════════════════════════════════════════
// ERROR CONSTANTS
// ═══════════════════════════════════════════════════════

/// OwnerCap.vault_id does not match the target Vault
const EInvalidCap: u64 = 0;

// ═══════════════════════════════════════════════════════
// STRUCT DEFINITIONS
// ═══════════════════════════════════════════════════════

/// The core vault that holds user assets.
/// Instantiated as a Shared Object via `transfer::share_object`.
///
/// IMPORTANT: Does NOT have the `store` ability — it cannot be transferred
/// or wrapped inside another object. Once shared, it stays shared forever.
///
/// Asset balances are stored as Dynamic Fields on `self.id`:
///   Key:   `std::type_name::TypeName` (unique per token type)
///   Value: `sui::balance::Balance<T>`
public struct Vault has key {
    id: UID,
    /// Monotonically increasing version counter.
    /// Incremented by the owner to universally revoke all DelegatedTradingCaps.
    version: u64,
    /// Maximum slippage tolerance in basis points (e.g., 100 = 1%).
    /// Agent-provided min_out values are validated against this ceiling.
    max_slippage_bps: u64,
    /// Emergency kill switch. When false, all trades are rejected
    /// regardless of cap validity.
    trading_enabled: bool,
}

/// Grants absolute authority over a specific Vault.
/// Minted once during vault creation and transferred to the creator.
///
/// Has `key + store` so it can be transferred between addresses
/// via `transfer::public_transfer` — enabling ownership delegation
/// or wrapping inside multisig/timelock constructs.
public struct OwnerCap has key, store {
    id: UID,
    /// The ID of the Vault this cap controls.
    vault_id: ID,
}

// ═══════════════════════════════════════════════════════
// PUBLIC FUNCTIONS
// ═══════════════════════════════════════════════════════

/// Create a new Vault as a Shared Object and transfer the OwnerCap
/// to the transaction sender.
///
/// The OwnerCap is transferred within this function (not returned) because
/// vault creation is a one-time bootstrap operation, not a PTB-composable
/// primitive. The self_transfer lint is suppressed deliberately.
#[allow(lint(self_transfer))]
public fun create_vault_and_share(
    max_slippage_bps: u64,
    ctx: &mut TxContext,
) {
    let vault = Vault {
        id: object::new(ctx),
        version: 0,
        max_slippage_bps,
        trading_enabled: true,
    };

    let owner_cap = OwnerCap {
        id: object::new(ctx),
        vault_id: object::id(&vault),
    };

    // Emit creation event via the events module
    events::emit_vault_created(
        object::id(&vault),
        ctx.sender(),
        max_slippage_bps,
    );

    // Share the vault — makes it a Shared Object accessible by anyone
    // through Mysticeti consensus
    transfer::share_object(vault);

    // Transfer OwnerCap to the creator — this is an Owned Object
    // that goes through the Fast Path (~400ms finality)
    transfer::transfer(owner_cap, ctx.sender());
}

/// Deposit any fungible token type into the vault.
/// Creates a new Dynamic Field if this is the first deposit of this asset type.
/// Requires the OwnerCap for authorization.
public fun deposit<T>(
    vault: &mut Vault,
    owner_cap: &OwnerCap,
    coin: Coin<T>,
    _ctx: &mut TxContext,
) {
    // Validate owner controls this vault
    assert!(owner_cap.vault_id == object::id(vault), EInvalidCap);

    let key = type_name::with_defining_ids<T>();
    let amount = coin::value(&coin);

    if (dynamic_field::exists_(&vault.id, key)) {
        // Merge into existing balance
        let balance_mut = dynamic_field::borrow_mut<TypeName, Balance<T>>(
            &mut vault.id, key,
        );
        balance::join(balance_mut, coin::into_balance(coin));
    } else {
        // First deposit of this asset type — create the Dynamic Field
        dynamic_field::add(&mut vault.id, key, coin::into_balance(coin));
    };

    // Emit balance change event
    events::emit_balance_changed(
        object::id(vault),
        type_name::into_string(type_name::with_defining_ids<T>()).into_bytes(),
        amount,
        true, // is_deposit
    );
}

/// Withdraw a specific amount of any token from the vault.
/// Returns the withdrawn amount as a `Coin<T>`.
/// Requires the OwnerCap for authorization.
public fun withdraw<T>(
    vault: &mut Vault,
    owner_cap: &OwnerCap,
    amount: u64,
    ctx: &mut TxContext,
): Coin<T> {
    // Validate owner controls this vault
    assert!(owner_cap.vault_id == object::id(vault), EInvalidCap);

    // Capture vault_id and type string BEFORE the mutable borrow on vault.id
    // (Move borrow checker prevents immutable access while mutable borrow is active)
    let vault_id = object::id(vault);
    let asset_type = type_name::into_string(type_name::with_defining_ids<T>()).into_bytes();

    let key = type_name::with_defining_ids<T>();
    let balance_mut = dynamic_field::borrow_mut<TypeName, Balance<T>>(
        &mut vault.id, key,
    );

    // Split the requested amount from the balance and wrap it as a Coin
    let withdrawn_coin = coin::take(balance_mut, amount, ctx);

    // Emit balance change event (after mutable borrow is released)
    events::emit_balance_changed(
        vault_id,
        asset_type,
        amount,
        false, // is_deposit = false → withdrawal
    );

    withdrawn_coin
}

/// Query the current balance of any token type in the vault.
/// Returns 0 if the vault has never held this asset type.
/// Read-only — no authorization required.
public fun balance_of<T>(vault: &Vault): u64 {
    let key = type_name::with_defining_ids<T>();
    if (dynamic_field::exists_(&vault.id, key)) {
        balance::value(
            dynamic_field::borrow<TypeName, Balance<T>>(&vault.id, key),
        )
    } else {
        0
    }
}

/// Revoke ALL outstanding DelegatedTradingCaps in O(1).
/// Simply increments the vault's version counter.
/// All caps minted with a previous version will fail the version check
/// in `authenticate_trade`, effectively revoking them instantly.
public fun revoke_all_delegations(
    vault: &mut Vault,
    owner_cap: &OwnerCap,
    _ctx: &TxContext,
) {
    assert!(owner_cap.vault_id == object::id(vault), EInvalidCap);

    vault.version = vault.version + 1;

    events::emit_all_delegations_revoked(
        object::id(vault),
        vault.version,
    );
}

/// Enable or disable all trading on this vault.
/// When disabled, all trades are rejected regardless of cap validity.
/// This is the emergency kill switch.
public fun set_trading_enabled(
    vault: &mut Vault,
    owner_cap: &OwnerCap,
    enabled: bool,
    _ctx: &TxContext,
) {
    assert!(owner_cap.vault_id == object::id(vault), EInvalidCap);

    vault.trading_enabled = enabled;

    events::emit_trading_status_changed(
        object::id(vault),
        enabled,
    );
}

/// Emergency withdraw the entire balance of a specific token type.
/// Drains the vault's balance for type T and returns it as a Coin.
/// Requires the OwnerCap — this is a privileged owner-only operation.
public fun emergency_withdraw_all<T>(
    vault: &mut Vault,
    owner_cap: &OwnerCap,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(owner_cap.vault_id == object::id(vault), EInvalidCap);

    let key = type_name::with_defining_ids<T>();
    // Remove the entire Balance<T> from the dynamic field
    let balance: Balance<T> = dynamic_field::remove(&mut vault.id, key);
    let amount = balance::value(&balance);

    // Emit balance change event
    events::emit_balance_changed(
        object::id(vault),
        type_name::into_string(type_name::with_defining_ids<T>()).into_bytes(),
        amount,
        false, // withdrawal
    );

    // Convert the extracted Balance into a Coin for the owner
    coin::from_balance(balance, ctx)
}

// ═══════════════════════════════════════════════════════
// PUBLIC ACCESSORS — for cross-module reads
// ═══════════════════════════════════════════════════════

/// Returns the current version counter of the vault.
/// Used by capabilities.move to snapshot version at mint time,
/// and by trading.move to validate cap version matches.
public fun version(vault: &Vault): u64 {
    vault.version
}

/// Returns the maximum slippage tolerance in basis points.
/// Used by trading.move to enforce vault-level slippage ceiling.
public fun max_slippage_bps(vault: &Vault): u64 {
    vault.max_slippage_bps
}

/// Returns whether trading is currently enabled.
/// Used by trading.move in authenticate_trade.
public fun trading_enabled(vault: &Vault): bool {
    vault.trading_enabled
}

/// Returns the vault_id linked to an OwnerCap.
/// Used by capabilities.move to validate OwnerCap against Vault.
public fun owner_cap_vault_id(cap: &OwnerCap): ID {
    cap.vault_id
}

// ═══════════════════════════════════════════════════════
// PUBLIC(PACKAGE) ACCESSORS — for cross-module mutation
// ═══════════════════════════════════════════════════════

/// Provides mutable access to the vault's UID for dynamic field operations.
/// This allows trading.move to extract/deposit coins from/to the vault's
/// dynamic fields without going through the owner-gated deposit/withdraw.
///
/// Restricted to `public(package)` — only modules within this package
/// can call this, preventing external packages from manipulating vault fields.
public(package) fun uid_mut(vault: &mut Vault): &mut UID {
    &mut vault.id
}

/// Provides read-only access to the vault's UID for dynamic field queries.
public(package) fun uid(vault: &Vault): &UID {
    &vault.id
}

// ═══════════════════════════════════════════════════════
// TEST-ONLY HELPERS
// ═══════════════════════════════════════════════════════

#[test_only]
/// Create a vault and return both objects directly (without sharing/transferring).
/// This enables unit tests that don't need a full `test_scenario`.
public fun create_vault_for_testing(
    max_slippage_bps: u64,
    ctx: &mut TxContext,
): (Vault, OwnerCap) {
    let vault = Vault {
        id: object::new(ctx),
        version: 0,
        max_slippage_bps,
        trading_enabled: true,
    };

    let owner_cap = OwnerCap {
        id: object::new(ctx),
        vault_id: object::id(&vault),
    };

    (vault, owner_cap)
}
