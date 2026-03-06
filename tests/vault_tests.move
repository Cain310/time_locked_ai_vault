#[test_only]
module time_locked_vault::vault_tests;

// ═══════════════════════════════════════════════════════
// IMPORTS
// ═══════════════════════════════════════════════════════

use sui::test_scenario;
use sui::coin;
use sui::sui::SUI;
use std::unit_test::destroy;

use time_locked_vault::vault::{Self, Vault, OwnerCap};

// ═══════════════════════════════════════════════════════
// TEST-ONLY TYPES & CONSTANTS
// ═══════════════════════════════════════════════════════

/// Dummy second asset type for multi-asset tests.
/// Has `drop` so it satisfies the phantom type constraint for Balance<T>/Coin<T>.
public struct USDC has drop {}

/// Standard test addresses
const OWNER: address = @0xA;

// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// TIER 1: UNIT TESTS
//
// These use vault::create_vault_for_testing() which returns
// (Vault, OwnerCap) directly — no sharing, no transfers.
// The objects live entirely within the test function scope.
// We clean up with std::unit_test::destroy() at the end.
// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────
// Test 1: Vault creation sets correct initial state
// ─────────────────────────────────────────────────────
#[test]
fun test_create_vault_initial_state() {
    let mut ctx = tx_context::dummy();
    let (vault, owner_cap) = vault::create_vault_for_testing(100, &mut ctx);

    // Verify initial vault state
    assert!(vault::version(&vault) == 0);
    assert!(vault::max_slippage_bps(&vault) == 100);
    assert!(vault::trading_enabled(&vault) == true);

    // Verify OwnerCap is linked to this specific vault
    assert!(vault::owner_cap_vault_id(&owner_cap) == object::id(&vault));

    // Cleanup — Move requires all non-drop objects to be explicitly consumed
    destroy(vault);
    destroy(owner_cap);
}

// ─────────────────────────────────────────────────────
// Test 2: Deposit and balance query
// ─────────────────────────────────────────────────────
#[test]
fun test_deposit_and_balance_of() {
    let mut ctx = tx_context::dummy();
    let (mut vault, owner_cap) = vault::create_vault_for_testing(100, &mut ctx);

    // Mint 1 SUI (1_000_000_000 MIST) for testing and deposit
    let coin = coin::mint_for_testing<SUI>(1_000_000_000, &mut ctx);
    vault::deposit(&mut vault, &owner_cap, coin, &mut ctx);

    // Verify balance matches deposited amount
    assert!(vault::balance_of<SUI>(&vault) == 1_000_000_000);

    destroy(vault);
    destroy(owner_cap);
}

// ─────────────────────────────────────────────────────
// Test 3: Balance of an undeposited type returns 0
// ─────────────────────────────────────────────────────
#[test]
fun test_balance_of_undeposited_type_returns_zero() {
    let mut ctx = tx_context::dummy();
    let (vault, owner_cap) = vault::create_vault_for_testing(100, &mut ctx);

    // Never deposited USDC — balance_of should return 0, not abort
    assert!(vault::balance_of<USDC>(&vault) == 0);

    destroy(vault);
    destroy(owner_cap);
}

// ─────────────────────────────────────────────────────
// Test 4: Withdraw returns correct amount and updates balance
// ─────────────────────────────────────────────────────
#[test]
fun test_withdraw() {
    let mut ctx = tx_context::dummy();
    let (mut vault, owner_cap) = vault::create_vault_for_testing(100, &mut ctx);

    // Deposit 5 SUI
    let coin = coin::mint_for_testing<SUI>(5_000_000_000, &mut ctx);
    vault::deposit(&mut vault, &owner_cap, coin, &mut ctx);
    assert!(vault::balance_of<SUI>(&vault) == 5_000_000_000);

    // Withdraw 2 SUI
    let withdrawn = vault::withdraw<SUI>(
        &mut vault, &owner_cap, 2_000_000_000, &mut ctx,
    );
    assert!(coin::value(&withdrawn) == 2_000_000_000);
    assert!(vault::balance_of<SUI>(&vault) == 3_000_000_000);

    destroy(withdrawn);
    destroy(vault);
    destroy(owner_cap);
}

// ─────────────────────────────────────────────────────
// Test 5: Multiple deposits of the same asset merge correctly
// ─────────────────────────────────────────────────────
#[test]
fun test_multiple_deposits_same_asset() {
    let mut ctx = tx_context::dummy();
    let (mut vault, owner_cap) = vault::create_vault_for_testing(100, &mut ctx);

    // Deposit 1 SUI
    let coin1 = coin::mint_for_testing<SUI>(1_000_000_000, &mut ctx);
    vault::deposit(&mut vault, &owner_cap, coin1, &mut ctx);
    assert!(vault::balance_of<SUI>(&vault) == 1_000_000_000);

    // Deposit another 2 SUI — should merge via balance::join
    let coin2 = coin::mint_for_testing<SUI>(2_000_000_000, &mut ctx);
    vault::deposit(&mut vault, &owner_cap, coin2, &mut ctx);
    assert!(vault::balance_of<SUI>(&vault) == 3_000_000_000);

    destroy(vault);
    destroy(owner_cap);
}

// ─────────────────────────────────────────────────────
// Test 6: Multi-asset deposits tracked independently
// ─────────────────────────────────────────────────────
#[test]
fun test_multi_asset_deposit() {
    let mut ctx = tx_context::dummy();
    let (mut vault, owner_cap) = vault::create_vault_for_testing(100, &mut ctx);

    // Deposit SUI
    let sui_coin = coin::mint_for_testing<SUI>(1_000_000_000, &mut ctx);
    vault::deposit(&mut vault, &owner_cap, sui_coin, &mut ctx);

    // Deposit USDC (different asset type → different Dynamic Field key)
    let usdc_coin = coin::mint_for_testing<USDC>(5_000_000, &mut ctx);
    vault::deposit(&mut vault, &owner_cap, usdc_coin, &mut ctx);

    // Both balances should be independently tracked via TypeName keys
    assert!(vault::balance_of<SUI>(&vault) == 1_000_000_000);
    assert!(vault::balance_of<USDC>(&vault) == 5_000_000);

    destroy(vault);
    destroy(owner_cap);
}

// ─────────────────────────────────────────────────────
// Test 7: Emergency withdraw drains entire balance
// ─────────────────────────────────────────────────────
#[test]
fun test_emergency_withdraw_all() {
    let mut ctx = tx_context::dummy();
    let (mut vault, owner_cap) = vault::create_vault_for_testing(100, &mut ctx);

    // Deposit 10 SUI
    let coin = coin::mint_for_testing<SUI>(10_000_000_000, &mut ctx);
    vault::deposit(&mut vault, &owner_cap, coin, &mut ctx);
    assert!(vault::balance_of<SUI>(&vault) == 10_000_000_000);

    // Emergency withdraw all — removes the entire Dynamic Field
    let withdrawn = vault::emergency_withdraw_all<SUI>(
        &mut vault, &owner_cap, &mut ctx,
    );
    assert!(coin::value(&withdrawn) == 10_000_000_000);

    // Balance should return 0 (dynamic field no longer exists)
    assert!(vault::balance_of<SUI>(&vault) == 0);

    destroy(withdrawn);
    destroy(vault);
    destroy(owner_cap);
}

// ─────────────────────────────────────────────────────
// Test 8: Deposit-then-full-withdraw-then-redeposit cycle
// ─────────────────────────────────────────────────────
#[test]
fun test_deposit_withdraw_redeposit_cycle() {
    let mut ctx = tx_context::dummy();
    let (mut vault, owner_cap) = vault::create_vault_for_testing(100, &mut ctx);

    // First deposit
    let coin1 = coin::mint_for_testing<SUI>(1_000_000_000, &mut ctx);
    vault::deposit(&mut vault, &owner_cap, coin1, &mut ctx);
    assert!(vault::balance_of<SUI>(&vault) == 1_000_000_000);

    // Emergency withdraw all (removes dynamic field entirely)
    let withdrawn = vault::emergency_withdraw_all<SUI>(
        &mut vault, &owner_cap, &mut ctx,
    );
    assert!(vault::balance_of<SUI>(&vault) == 0);

    // Redeposit — must create a NEW dynamic field since the old one was removed
    let coin2 = coin::mint_for_testing<SUI>(2_000_000_000, &mut ctx);
    vault::deposit(&mut vault, &owner_cap, coin2, &mut ctx);
    assert!(vault::balance_of<SUI>(&vault) == 2_000_000_000);

    destroy(withdrawn);
    destroy(vault);
    destroy(owner_cap);
}

// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// TIER 2: SCENARIO TESTS
//
// These use test_scenario for multi-transaction flows.
// create_vault_and_share() shares the Vault and transfers
// the OwnerCap — we retrieve them via take_shared/take_from_sender.
// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────
// Test 9: Vault creation via shared API produces correct objects
// ─────────────────────────────────────────────────────
#[test]
fun test_create_vault_and_share_scenario() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Owner creates vault via the public shared API ───
    {
        vault::create_vault_and_share(
            100, // max_slippage_bps = 1%
            test_scenario::ctx(&mut scenario),
        );
    };

    // ─── TX 2: Verify objects exist in the expected locations ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        // The Vault should be a shared object — accessible to anyone
        let vault = test_scenario::take_shared<Vault>(&scenario);
        assert!(vault::version(&vault) == 0);
        assert!(vault::max_slippage_bps(&vault) == 100);
        assert!(vault::trading_enabled(&vault) == true);

        // The OwnerCap should be owned by OWNER (the TX sender)
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);
        assert!(vault::owner_cap_vault_id(&owner_cap) == object::id(&vault));

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    test_scenario::end(scenario);
}

// ─────────────────────────────────────────────────────
// Test 10: Multi-TX deposit and withdraw flow
// ─────────────────────────────────────────────────────
#[test]
fun test_deposit_withdraw_scenario() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Create vault ───
    {
        vault::create_vault_and_share(
            100,
            test_scenario::ctx(&mut scenario),
        );
    };

    // ─── TX 2: Deposit 10 SUI ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let mut vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        let coin = coin::mint_for_testing<SUI>(
            10_000_000_000,
            test_scenario::ctx(&mut scenario),
        );
        vault::deposit(
            &mut vault,
            &owner_cap,
            coin,
            test_scenario::ctx(&mut scenario),
        );

        assert!(vault::balance_of<SUI>(&vault) == 10_000_000_000);

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 3: Withdraw 3 SUI ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let mut vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        let withdrawn = vault::withdraw<SUI>(
            &mut vault,
            &owner_cap,
            3_000_000_000,
            test_scenario::ctx(&mut scenario),
        );
        assert!(coin::value(&withdrawn) == 3_000_000_000);
        assert!(vault::balance_of<SUI>(&vault) == 7_000_000_000);

        // In a real PTB, the Coin would be transferred to the owner.
        // In tests, we destroy it to satisfy the non-drop constraint.
        destroy(withdrawn);

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    test_scenario::end(scenario);
}

// ─────────────────────────────────────────────────────
// Test 11: Version increments on revoke_all_delegations
// ─────────────────────────────────────────────────────
#[test]
fun test_revoke_all_delegations_increments_version() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Create vault ───
    {
        vault::create_vault_and_share(
            100,
            test_scenario::ctx(&mut scenario),
        );
    };

    // ─── TX 2: Revoke — version goes from 0 → 1 ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let mut vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        assert!(vault::version(&vault) == 0);

        vault::revoke_all_delegations(
            &mut vault,
            &owner_cap,
            test_scenario::ctx(&mut scenario),
        );
        assert!(vault::version(&vault) == 1);

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 3: Revoke again — version goes from 1 → 2 ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let mut vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        assert!(vault::version(&vault) == 1);

        vault::revoke_all_delegations(
            &mut vault,
            &owner_cap,
            test_scenario::ctx(&mut scenario),
        );
        assert!(vault::version(&vault) == 2);

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    test_scenario::end(scenario);
}

// ─────────────────────────────────────────────────────
// Test 12: Trading enable/disable toggle
// ─────────────────────────────────────────────────────
#[test]
fun test_set_trading_enabled() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Create vault ───
    {
        vault::create_vault_and_share(
            100,
            test_scenario::ctx(&mut scenario),
        );
    };

    // ─── TX 2: Disable trading ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let mut vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        assert!(vault::trading_enabled(&vault) == true);

        vault::set_trading_enabled(
            &mut vault,
            &owner_cap,
            false,
            test_scenario::ctx(&mut scenario),
        );
        assert!(vault::trading_enabled(&vault) == false);

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 3: Re-enable trading ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let mut vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        assert!(vault::trading_enabled(&vault) == false);

        vault::set_trading_enabled(
            &mut vault,
            &owner_cap,
            true,
            test_scenario::ctx(&mut scenario),
        );
        assert!(vault::trading_enabled(&vault) == true);

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    test_scenario::end(scenario);
}

// ─────────────────────────────────────────────────────
// Test 13: Multi-asset scenario (deposit two types, withdraw one)
// ─────────────────────────────────────────────────────
#[test]
fun test_multi_asset_scenario() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Create vault ───
    {
        vault::create_vault_and_share(
            200, // 2% max slippage
            test_scenario::ctx(&mut scenario),
        );
    };

    // ─── TX 2: Deposit SUI and USDC ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let mut vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        // Deposit 5 SUI
        let sui_coin = coin::mint_for_testing<SUI>(
            5_000_000_000,
            test_scenario::ctx(&mut scenario),
        );
        vault::deposit(
            &mut vault,
            &owner_cap,
            sui_coin,
            test_scenario::ctx(&mut scenario),
        );

        // Deposit 1000 USDC
        let usdc_coin = coin::mint_for_testing<USDC>(
            1_000_000_000,
            test_scenario::ctx(&mut scenario),
        );
        vault::deposit(
            &mut vault,
            &owner_cap,
            usdc_coin,
            test_scenario::ctx(&mut scenario),
        );

        assert!(vault::balance_of<SUI>(&vault) == 5_000_000_000);
        assert!(vault::balance_of<USDC>(&vault) == 1_000_000_000);

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 3: Withdraw SUI only — USDC unchanged ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let mut vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        let withdrawn_sui = vault::withdraw<SUI>(
            &mut vault,
            &owner_cap,
            2_000_000_000,
            test_scenario::ctx(&mut scenario),
        );
        assert!(coin::value(&withdrawn_sui) == 2_000_000_000);
        assert!(vault::balance_of<SUI>(&vault) == 3_000_000_000);
        // USDC remains untouched — Dynamic Fields are independent
        assert!(vault::balance_of<USDC>(&vault) == 1_000_000_000);

        destroy(withdrawn_sui);

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    test_scenario::end(scenario);
}

// ─────────────────────────────────────────────────────
// Test 14: Emergency withdraw in scenario context
// ─────────────────────────────────────────────────────
#[test]
fun test_emergency_withdraw_all_scenario() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Create vault ───
    {
        vault::create_vault_and_share(
            100,
            test_scenario::ctx(&mut scenario),
        );
    };

    // ─── TX 2: Deposit 8 SUI ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let mut vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        let coin = coin::mint_for_testing<SUI>(
            8_000_000_000,
            test_scenario::ctx(&mut scenario),
        );
        vault::deposit(
            &mut vault,
            &owner_cap,
            coin,
            test_scenario::ctx(&mut scenario),
        );

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 3: Emergency withdraw all SUI ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let mut vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        let withdrawn = vault::emergency_withdraw_all<SUI>(
            &mut vault,
            &owner_cap,
            test_scenario::ctx(&mut scenario),
        );
        assert!(coin::value(&withdrawn) == 8_000_000_000);
        assert!(vault::balance_of<SUI>(&vault) == 0);

        destroy(withdrawn);

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    test_scenario::end(scenario);
}
