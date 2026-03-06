#[test_only]
module time_locked_vault::negative_tests;

// ═══════════════════════════════════════════════════════
// IMPORTS
// ═══════════════════════════════════════════════════════

use sui::test_scenario;
use sui::clock;
use std::unit_test::destroy;

use time_locked_vault::vault::{Self, Vault, OwnerCap};
use time_locked_vault::capabilities::{Self, DelegatedTradingCap};
use time_locked_vault::trading;

// ═══════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════

const OWNER: address = @0xA;
const AGENT: address = @0xB;

// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// NEGATIVE TESTS — Security Proofs by Intentional Failure
//
// Each test constructs a specific violation condition and
// proves the system correctly aborts with the precise error
// code. These are the MOST CRITICAL tests for the interview.
//
// authenticate_trade assertion ordering (cheapest first):
//   1. cap.vault_id == object::id(vault)       → EInvalidVault  (3)
//   2. vault.trading_enabled == true            → ETradingDisabled (5)
//   3. cap.version == vault.version             → ECapRevoked    (2)
//   4. cap.expiration_epoch > ctx.epoch()       → ECapExpired    (0)
//   5. trade_amount <= cap.max_trade_size       → ETradeTooLarge (4)
//   6. cap.remaining_trade_volume >= trade_amt  → EQuotaExceeded (1)
//
// For each test, all checks BEFORE the target PASS,
// and only the target check FAILS.
// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────
// PROOF 1: Expired capability is rejected
//
// Setup: Mint cap with expiration_epoch = 2, advance to epoch 2.
// Checks 1-3 pass (correct vault, trading enabled, version match).
// Check 4 fails: cap.expiration_epoch (2) > ctx.epoch() (2) → FALSE
// ─────────────────────────────────────────────────────
#[test]
#[expected_failure(abort_code = trading::ECapExpired)]
fun test_expired_cap_rejected() {
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
            2,                   // expiration_epoch = 2 (expires AT epoch 2)
            5_000_000_000,       // volume
            1_000_000_000,       // max_trade_size
            test_scenario::ctx(&mut scenario),
        );

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── Advance to epoch 2 (past expiration) ───
    // next_epoch: epoch 0 → 1
    test_scenario::next_epoch(&mut scenario, AGENT);
    // next_epoch: epoch 1 → 2
    test_scenario::next_epoch(&mut scenario, AGENT);

    // ─── TX at epoch 2: AGENT attempts trade — MUST abort ───
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let mut cap = test_scenario::take_from_sender<DelegatedTradingCap>(&scenario);
        let clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));

        // This MUST abort with ECapExpired:
        //   cap.expiration_epoch (2) > ctx.epoch() (2) → FALSE → abort
        trading::authenticate_trade(
            &vault,
            &mut cap,
            1_000,
            &clock,
            test_scenario::ctx(&mut scenario),
        );

        // ── Unreachable cleanup (compiler still verifies types) ──
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, cap);
    };

    test_scenario::end(scenario);
}

// ─────────────────────────────────────────────────────
// PROOF 2: Exhausted quota is rejected
//
// Setup: Mint cap with volume = 500, max_trade = 1000.
// Attempt trade_amount = 600 (exceeds remaining volume).
// Checks 1-5 pass. Check 6 fails: 500 >= 600 → FALSE
// ─────────────────────────────────────────────────────
#[test]
#[expected_failure(abort_code = trading::EQuotaExceeded)]
fun test_quota_exceeded_rejected() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Create vault ───
    {
        vault::create_vault_and_share(
            100,
            test_scenario::ctx(&mut scenario),
        );
    };

    // ─── TX 2: Mint cap with volume = 500, max_trade = 1000 ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        capabilities::mint_delegated_trading_cap(
            &vault,
            &owner_cap,
            AGENT,
            100,                 // far future expiration
            500,                 // remaining_trade_volume = 500
            1000,                // max_trade_size = 1000 (trade_amount fits under this)
            test_scenario::ctx(&mut scenario),
        );

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 3: AGENT attempts trade of 600 — exceeds 500 quota ───
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let mut cap = test_scenario::take_from_sender<DelegatedTradingCap>(&scenario);
        let clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));

        // This MUST abort with EQuotaExceeded:
        //   cap.remaining_trade_volume (500) >= trade_amount (600) → FALSE → abort
        trading::authenticate_trade(
            &vault,
            &mut cap,
            600,                 // trade_amount exceeds remaining volume
            &clock,
            test_scenario::ctx(&mut scenario),
        );

        // ── Unreachable cleanup ──
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, cap);
    };

    test_scenario::end(scenario);
}

// ─────────────────────────────────────────────────────
// PROOF 3: Revoked capability (version mismatch) is rejected
//
// Setup: Mint cap at version 0, then bump vault to version 1.
// Checks 1-2 pass. Check 3 fails: cap.version (0) == vault.version (1) → FALSE
// ─────────────────────────────────────────────────────
#[test]
#[expected_failure(abort_code = trading::ECapRevoked)]
fun test_revoked_cap_rejected() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Create vault (version = 0) ───
    {
        vault::create_vault_and_share(
            100,
            test_scenario::ctx(&mut scenario),
        );
    };

    // ─── TX 2: Mint cap at version 0 ───
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

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 4: AGENT attempts trade with stale cap — MUST abort ───
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let mut cap = test_scenario::take_from_sender<DelegatedTradingCap>(&scenario);
        let clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));

        // This MUST abort with ECapRevoked:
        //   cap.version (0) == vault.version (1) → FALSE → abort
        trading::authenticate_trade(
            &vault,
            &mut cap,
            1_000,
            &clock,
            test_scenario::ctx(&mut scenario),
        );

        // ── Unreachable cleanup ──
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, cap);
    };

    test_scenario::end(scenario);
}

// ─────────────────────────────────────────────────────
// PROOF 4: Wrong vault ID is rejected
//
// Setup: Mint cap for vault_A, authenticate against vault_B.
// Check 1 fails immediately: cap.vault_id != object::id(vault_B) → FALSE
// ─────────────────────────────────────────────────────
#[test]
#[expected_failure(abort_code = trading::EInvalidVault)]
fun test_wrong_vault_rejected() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Create vault_A (shared) ───
    {
        vault::create_vault_and_share(
            100,
            test_scenario::ctx(&mut scenario),
        );
    };

    // ─── TX 2: Mint cap linked to vault_A → AGENT ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let vault_a = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        capabilities::mint_delegated_trading_cap(
            &vault_a,
            &owner_cap,
            AGENT,
            100,
            5_000_000_000,
            1_000_000_000,
            test_scenario::ctx(&mut scenario),
        );

        test_scenario::return_shared(vault_a);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 3: AGENT creates vault_B and tries to trade on it ───
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        // Create a DIFFERENT vault (vault_B) with a different ID
        let (vault_b, owner_cap_b) = vault::create_vault_for_testing(
            200,
            test_scenario::ctx(&mut scenario),
        );
        let mut cap = test_scenario::take_from_sender<DelegatedTradingCap>(&scenario);
        let clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));

        // This MUST abort with EInvalidVault:
        //   cap.vault_id (vault_A.id) == object::id(vault_B) → FALSE → abort
        trading::authenticate_trade(
            &vault_b,            // WRONG vault — cap was minted for vault_A
            &mut cap,
            1_000,
            &clock,
            test_scenario::ctx(&mut scenario),
        );

        // ── Unreachable cleanup ──
        clock::destroy_for_testing(clock);
        test_scenario::return_to_sender(&scenario, cap);
        destroy(vault_b);
        destroy(owner_cap_b);
    };

    test_scenario::end(scenario);
}

// ─────────────────────────────────────────────────────
// PROOF 5: Trade exceeding per-trade size limit is rejected
//
// Setup: Mint cap with max_trade_size = 500.
// Attempt trade_amount = 600 (exceeds per-trade ceiling).
// Checks 1-4 pass. Check 5 fails: 600 <= 500 → FALSE
// ─────────────────────────────────────────────────────
#[test]
#[expected_failure(abort_code = trading::ETradeTooLarge)]
fun test_trade_too_large_rejected() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Create vault ───
    {
        vault::create_vault_and_share(
            100,
            test_scenario::ctx(&mut scenario),
        );
    };

    // ─── TX 2: Mint cap with max_trade_size = 500, volume = 10000 ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        capabilities::mint_delegated_trading_cap(
            &vault,
            &owner_cap,
            AGENT,
            100,                 // far future expiration
            10000,               // plenty of volume (won't trigger quota check)
            500,                 // max_trade_size = 500 ← the constraint under test
            test_scenario::ctx(&mut scenario),
        );

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 3: AGENT attempts trade of 600 — exceeds 500 max ───
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let mut cap = test_scenario::take_from_sender<DelegatedTradingCap>(&scenario);
        let clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));

        // This MUST abort with ETradeTooLarge:
        //   trade_amount (600) <= cap.max_trade_size (500) → FALSE → abort
        trading::authenticate_trade(
            &vault,
            &mut cap,
            600,                 // exceeds max_trade_size of 500
            &clock,
            test_scenario::ctx(&mut scenario),
        );

        // ── Unreachable cleanup ──
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, cap);
    };

    test_scenario::end(scenario);
}

// ─────────────────────────────────────────────────────
// PROOF 6: Trading disabled by owner is rejected
//
// Setup: Owner disables trading, agent tries to trade.
// Check 1 passes (correct vault). Check 2 fails:
//   vault.trading_enabled (false) → FALSE → abort
// ─────────────────────────────────────────────────────
#[test]
#[expected_failure(abort_code = trading::ETradingDisabled)]
fun test_trading_disabled_rejected() {
    let mut scenario = test_scenario::begin(OWNER);

    // ─── TX 1: Create vault ───
    {
        vault::create_vault_and_share(
            100,
            test_scenario::ctx(&mut scenario),
        );
    };

    // ─── TX 2: Mint cap for AGENT ───
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

    // ─── TX 3: Owner DISABLES trading (emergency kill switch) ───
    test_scenario::next_tx(&mut scenario, OWNER);
    {
        let mut vault = test_scenario::take_shared<Vault>(&scenario);
        let owner_cap = test_scenario::take_from_sender<OwnerCap>(&scenario);

        vault::set_trading_enabled(
            &mut vault,
            &owner_cap,
            false,               // DISABLE trading
            test_scenario::ctx(&mut scenario),
        );

        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, owner_cap);
    };

    // ─── TX 4: AGENT attempts trade — MUST abort ───
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let vault = test_scenario::take_shared<Vault>(&scenario);
        let mut cap = test_scenario::take_from_sender<DelegatedTradingCap>(&scenario);
        let clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));

        // This MUST abort with ETradingDisabled:
        //   vault.trading_enabled (false) → abort
        trading::authenticate_trade(
            &vault,
            &mut cap,
            1_000,
            &clock,
            test_scenario::ctx(&mut scenario),
        );

        // ── Unreachable cleanup ──
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(vault);
        test_scenario::return_to_sender(&scenario, cap);
    };

    test_scenario::end(scenario);
}
