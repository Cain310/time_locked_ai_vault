#[test_only]
module time_locked_vault::capability_tests;

// ═══════════════════════════════════════════════════════
// IMPORTS
// ═══════════════════════════════════════════════════════

use sui::test_scenario;
use sui::clock;
use time_locked_vault::vault::{Self, Vault, OwnerCap};
use time_locked_vault::capabilities::{Self, DelegatedTradingCap};
use time_locked_vault::trading;

// ═══════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════

const OWNER: address = @0xA;
const AGENT: address = @0xB;
const OTHER: address = @0xC;

// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// CAPABILITY LIFECYCLE TESTS
//
// All tests use test_scenario because cap minting involves
// transfer::public_transfer (objects must be routed to
// recipient addresses, which requires the scenario tracker).
// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────
// Test 1: Minted cap has correct fields from vault state
// ─────────────────────────────────────────────────────
#[test]
fun test_mint_cap_with_correct_fields() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Create vault ───
    {
        vault::create_vault_and_share(
            100,
            test_scenario::ctx(&mut scenario),
        );
    };

    // ─── TX 2: Owner mints a DelegatedTradingCap for AGENT ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        capabilities::mint_delegated_trading_cap(
            &vault,
            &owner_cap,
            AGENT,
            10,              // expiration_epoch
            5_000_000_000,   // trade_volume_limit (5 SUI)
            1_000_000_000,   // max_trade_size (1 SUI)
            test_scenario::ctx(&mut scenario),
        );

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 3: AGENT takes the cap and verifies all fields ───
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let cap = test_scenario::take_from_sender<DelegatedTradingCap>(&scenario);

        // Verify all cap fields via public accessors
        assert!(capabilities::cap_vault_id(&cap) == object::id(&vault));
        assert!(capabilities::expiration_epoch(&cap) == 10);
        assert!(capabilities::remaining_trade_volume(&cap) == 5_000_000_000);
        assert!(capabilities::max_trade_size(&cap) == 1_000_000_000);
        assert!(capabilities::cap_version(&cap) == 0); // vault.version was 0 at mint time

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, cap);
    };

    test_scenario::end(scenario);
}

// ─────────────────────────────────────────────────────
// Test 2: Cap snapshots vault version at mint time
//
// Demonstrates that caps minted BEFORE a revocation carry
// the old version, while caps minted AFTER carry the new one.
// ─────────────────────────────────────────────────────
#[test]
fun test_cap_version_snapshot() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Create vault (version = 0) ───
    {
        vault::create_vault_and_share(
            100,
            test_scenario::ctx(&mut scenario),
        );
    };

    // ─── TX 2: Mint cap_A at version 0 ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        assert!(vault::version(&vault) == 0);

        capabilities::mint_delegated_trading_cap(
            &vault,
            &owner_cap,
            AGENT,               // cap_A → AGENT
            100,                 // expiration_epoch
            5_000_000_000,
            1_000_000_000,
            test_scenario::ctx(&mut scenario),
        );

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 3: Verify cap_A has version 0 ───
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let cap_a = test_scenario::take_from_sender<DelegatedTradingCap>(&scenario);
        assert!(capabilities::cap_version(&cap_a) == 0);
        test_scenario::return_to_sender(&scenario, cap_a);
    };

    // ─── TX 4: Owner revokes all delegations → version bumps to 1 ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let mut vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        vault::revoke_all_delegations(
            &mut vault,
            &owner_cap,
            test_scenario::ctx(&mut scenario),
        );
        assert!(vault::version(&vault) == 1);

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 5: Mint cap_B at version 1 → sends to OTHER ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        capabilities::mint_delegated_trading_cap(
            &vault,
            &owner_cap,
            OTHER,               // cap_B → OTHER
            100,
            5_000_000_000,
            1_000_000_000,
            test_scenario::ctx(&mut scenario),
        );

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 6: Verify cap_B has version 1 ───
    test_scenario::next_tx(&mut scenario, OTHER);
    {
        let cap_b = test_scenario::take_from_sender<DelegatedTradingCap>(&scenario);
        assert!(capabilities::cap_version(&cap_b) == 1);
        test_scenario::return_to_sender(&scenario, cap_b);
    };

    // ─── TX 7: Verify cap_A still has stale version 0 ───
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let cap_a = test_scenario::take_from_sender<DelegatedTradingCap>(&scenario);
        assert!(capabilities::cap_version(&cap_a) == 0); // Stale — would be rejected on trade
        test_scenario::return_to_sender(&scenario, cap_a);
    };

    test_scenario::end(scenario);
}

// ─────────────────────────────────────────────────────
// Test 3: Cap can be transferred to a new owner
//
// DelegatedTradingCap has `key + store`, so
// transfer::public_transfer works. This demonstrates
// the `store` ability enabling secondary transfers.
// ─────────────────────────────────────────────────────
#[test]
fun test_cap_transfer_to_new_owner() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Create vault + mint cap to AGENT ───
    {
        vault::create_vault_and_share(
            100,
            test_scenario::ctx(&mut scenario),
        );
    };

    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        capabilities::mint_delegated_trading_cap(
            &vault,
            &owner_cap,
            AGENT,
            100,
            5_000_000_000,
            1_000_000_000,
            test_scenario::ctx(&mut scenario),
        );

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 2: AGENT transfers cap to OTHER ───
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let cap = test_scenario::take_from_sender<DelegatedTradingCap>(&scenario);

        // This works because DelegatedTradingCap has `store` ability.
        // Without `store`, this would be a compile error:
        //   "The type ... does not have the ability 'store'"
        transfer::public_transfer(cap, OTHER);
    };

    // ─── TX 3: OTHER now owns the cap ───
    test_scenario::next_tx(&mut scenario, OTHER);
    {
        let cap = test_scenario::take_from_sender<DelegatedTradingCap>(&scenario);

        // OTHER now possesses the trading authority
        assert!(capabilities::remaining_trade_volume(&cap) == 5_000_000_000);

        test_scenario::return_to_sender(&scenario, cap);
    };

    test_scenario::end(scenario);
}

// ─────────────────────────────────────────────────────
// Test 4: Destroy an EXPIRED cap (epoch advanced past expiration)
//
// Uses test_scenario::next_epoch to advance the epoch counter.
// This simulates real-world time passage on the Sui network.
// ─────────────────────────────────────────────────────
#[test]
fun test_destroy_expired_cap() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Create vault ───
    {
        vault::create_vault_and_share(
            100,
            test_scenario::ctx(&mut scenario),
        );
    };

    // ─── TX 2: Mint cap with expiration_epoch = 2 ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        capabilities::mint_delegated_trading_cap(
            &vault,
            &owner_cap,
            AGENT,
            2,               // expires at epoch 2
            5_000_000_000,
            1_000_000_000,
            test_scenario::ctx(&mut scenario),
        );

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── Advance epochs: 0 → 1 → 2 ───
    // Each next_epoch increments the epoch counter by 1
    test_scenario::next_epoch(&mut scenario, AGENT);
    test_scenario::next_epoch(&mut scenario, AGENT);
    // Now ctx.epoch() == 2, which means cap.expiration_epoch (2) <= epoch (2)

    // ─── TX at epoch 2: AGENT destroys the expired cap ───
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let cap = test_scenario::take_from_sender<DelegatedTradingCap>(&scenario);

        // Verify the cap shows as expired: epoch >= expiration_epoch
        assert!(capabilities::expiration_epoch(&cap) == 2);

        // destroy_inert_cap succeeds because epoch >= expiration_epoch
        // The cap is consumed (moved by value). No return needed.
        capabilities::destroy_inert_cap(
            &vault,
            cap,
            test_scenario::ctx(&mut scenario),
        );

        test_scenario::return_shared(vault);
        // No return_to_sender for cap — it was consumed by destroy_inert_cap
    };

    test_scenario::end(scenario);
}

// ─────────────────────────────────────────────────────
// Test 5: Destroy an EXHAUSTED cap (volume decremented to 0)
//
// Uses trading::authenticate_trade (public(package)) to
// decrement remaining_trade_volume to 0, then destroys.
// ─────────────────────────────────────────────────────
#[test]
fun test_destroy_exhausted_cap() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Create vault ───
    {
        vault::create_vault_and_share(
            100,
            test_scenario::ctx(&mut scenario),
        );
    };

    // ─── TX 2: Mint cap with volume = 1000, max_trade_size = 1000 ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        capabilities::mint_delegated_trading_cap(
            &vault,
            &owner_cap,
            AGENT,
            100,             // expires far in the future
            1000,            // remaining_trade_volume
            1000,            // max_trade_size
            test_scenario::ctx(&mut scenario),
        );

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 3: AGENT exhausts all volume, then destroys the cap ───
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let mut cap = test_scenario::take_from_sender<DelegatedTradingCap>(&scenario);
        let clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));

        // Exhaust the entire volume in one trade
        trading::authenticate_trade(
            &vault,
            &mut cap,
            1000,
            &clock,
            test_scenario::ctx(&mut scenario),
        );
        assert!(capabilities::remaining_trade_volume(&cap) == 0);

        // Cap is now inert (exhausted) — destroy it
        capabilities::destroy_inert_cap(
            &vault,
            cap, // moved by value — cap is consumed here
            test_scenario::ctx(&mut scenario),
        );

        clock::destroy_for_testing(clock);
        test_scenario::return_shared(vault);
    };

    test_scenario::end(scenario);
}

// ─────────────────────────────────────────────────────
// Test 6: Destroy a REVOKED cap (version mismatch)
//
// Owner calls revoke_all_delegations to bump vault version.
// Now cap.version != vault.version → cap is inert.
// ─────────────────────────────────────────────────────
#[test]
fun test_destroy_revoked_cap() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Create vault ───
    {
        vault::create_vault_and_share(
            100,
            test_scenario::ctx(&mut scenario),
        );
    };

    // ─── TX 2: Mint cap to AGENT (version snapshot = 0) ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        capabilities::mint_delegated_trading_cap(
            &vault,
            &owner_cap,
            AGENT,
            100,
            5_000_000_000,
            1_000_000_000,
            test_scenario::ctx(&mut scenario),
        );

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 3: Owner revokes all delegations (version 0 → 1) ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let mut vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        vault::revoke_all_delegations(
            &mut vault,
            &owner_cap,
            test_scenario::ctx(&mut scenario),
        );
        assert!(vault::version(&vault) == 1);

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 4: AGENT destroys the revoked cap ───
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let cap = test_scenario::take_from_sender<DelegatedTradingCap>(&scenario);

        // Verify version mismatch: cap.version (0) != vault.version (1)
        assert!(capabilities::cap_version(&cap) == 0);
        assert!(vault::version(&vault) == 1);

        // destroy_inert_cap succeeds because version mismatch → revoked
        capabilities::destroy_inert_cap(
            &vault,
            cap,
            test_scenario::ctx(&mut scenario),
        );

        test_scenario::return_shared(vault);
    };

    test_scenario::end(scenario);
}

// ─────────────────────────────────────────────────────
// Test 7: Volume is correctly decremented across multiple trades
//
// Verifies authenticate_trade correctly decrements
// remaining_trade_volume on each successful call.
// ─────────────────────────────────────────────────────
#[test]
fun test_volume_decrement_across_trades() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Create vault ───
    {
        vault::create_vault_and_share(
            100,
            test_scenario::ctx(&mut scenario),
        );
    };

    // ─── TX 2: Mint cap with volume = 3000, max_trade_size = 1500 ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        capabilities::mint_delegated_trading_cap(
            &vault,
            &owner_cap,
            AGENT,
            100,
            3000,            // remaining_trade_volume
            1500,            // max_trade_size
            test_scenario::ctx(&mut scenario),
        );

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 3: AGENT makes two trades, observing volume decrement ───
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let mut cap = test_scenario::take_from_sender<DelegatedTradingCap>(&scenario);
        let clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));

        assert!(capabilities::remaining_trade_volume(&cap) == 3000);

        // Trade 1: 1000 units → volume: 3000 - 1000 = 2000
        trading::authenticate_trade(
            &vault,
            &mut cap,
            1000,
            &clock,
            test_scenario::ctx(&mut scenario),
        );
        assert!(capabilities::remaining_trade_volume(&cap) == 2000);

        // Trade 2: 1500 units → volume: 2000 - 1500 = 500
        trading::authenticate_trade(
            &vault,
            &mut cap,
            1500,
            &clock,
            test_scenario::ctx(&mut scenario),
        );
        assert!(capabilities::remaining_trade_volume(&cap) == 500);

        clock::destroy_for_testing(clock);
        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, cap);
    };

    test_scenario::end(scenario);
}
