# Sui Move Best Practices — Style Guide & Source of Truth

## Time-Locked Vault with Delegated AI Trading Capabilities

> This document defines the **strict coding standards** for this project. Every contributor and every code review must enforce these rules. These practices are drawn from Mysten Labs conventions, the Move Book, and DeepBook V3's own CLAUDE.md coding guidelines.

---

## Table of Contents

1. [Package Configuration](#1-package-configuration)
2. [Naming Conventions](#2-naming-conventions)
3. [Ability Assignment Rules](#3-ability-assignment-rules)
4. [Balance\<T\> vs Coin\<T\> — The Critical Distinction](#4-balancet-vs-coint--the-critical-distinction)
5. [Shared Object Best Practices](#5-shared-object-best-practices)
6. [Capability Pattern Standards](#6-capability-pattern-standards)
7. [Dynamic Field Usage](#7-dynamic-field-usage)
8. [Error Handling](#8-error-handling)
9. [Function Visibility & Composability](#9-function-visibility--composability)
10. [Hot Potato Pattern Reference](#10-hot-potato-pattern-reference)
11. [Event Emission Standards](#11-event-emission-standards)
12. [Testing Standards](#12-testing-standards)
13. [Anti-Patterns to Avoid](#13-anti-patterns-to-avoid)
14. [Gas Optimization](#14-gas-optimization)

---

## 1. Package Configuration

### 1.1 Move.toml

```toml
[package]
name = "time_locked_vault"
edition = "2024.beta"

# Sui >= 1.45: Sui, Bridge, MoveStdlib, SuiSystem are implicit
[dependencies]
DeepBookV3 = { git = "https://github.com/MystenLabs/deepbookv3.git", subdir = "packages/deepbook", rev = "main" }

[addresses]
time_locked_vault = "0x0"
```

### 1.2 Rules

- **ALWAYS** use `edition = "2024.beta"` or `"2024"` — enables modern syntax (public struct, method syntax, positional fields)
- **NEVER** manually specify Sui framework dependencies when targeting Sui >= 1.45 — they are implicit
- **ALWAYS** use `0x0` as the package address in development — it is replaced on publish
- **ALWAYS** pin external dependency revisions to specific commits or tags for production

---

## 2. Naming Conventions

### 2.1 Modules

```move
// ✅ CORRECT: snake_case module names
module time_locked_vault::vault;
module time_locked_vault::capabilities;
module time_locked_vault::trading;

// ❌ WRONG: PascalCase modules
module time_locked_vault::Vault;
module time_locked_vault::TradingCapabilities;
```

### 2.2 Structs

```move
// ✅ CORRECT: PascalCase struct names
public struct Vault has key { ... }
public struct OwnerCap has key, store { ... }
public struct DelegatedTradingCap has key, store { ... }

// ❌ WRONG: snake_case structs
public struct owner_cap has key, store { ... }
```

### 2.3 Functions

```move
// ✅ CORRECT: snake_case function names, verb-first
public fun create_vault_and_share(...)
public fun mint_delegated_trading_cap(...)
public fun execute_swap_base_to_quote(...)
fun authenticate_trade(...)

// ❌ WRONG: unclear names
public fun do_swap(...)       // What kind of swap?
public fun process(...)       // Meaningless
public fun handle_trade(...)  // "handle" is vague
```

### 2.4 Error Constants

```move
// ✅ CORRECT: SCREAMING_SNAKE_CASE with 'E' prefix, sequential u64 values
const EInvalidCap: u64 = 0;
const ECapExpired: u64 = 1;
const EQuotaExceeded: u64 = 2;
const ECapRevoked: u64 = 3;
const EInvalidVault: u64 = 4;

// ❌ WRONG: magic numbers
assert!(cap.version == vault.version, 42);

// ❌ WRONG: non-prefixed constants
const INVALID_CAP: u64 = 0;
const CapExpired: u64 = 1;
```

### 2.5 Type Parameters

```move
// ✅ CORRECT: Descriptive type parameter names for DeFi context
public fun deposit<T>(...)
public fun execute_swap<BaseAsset, QuoteAsset>(...)

// ❌ WRONG: Single-letter generics (except T for single type param)
public fun execute_swap<A, B>(...)
```

---

## 3. Ability Assignment Rules

### 3.1 The Decision Tree

```
Does it need a UID (is it an on-chain object)?
├── YES → needs `key`
│   ├── Should it be transferable/wrappable?
│   │   ├── YES → add `store`
│   │   └── NO → `key` only (immovable once shared/transferred)
│   ├── Should it be duplicable?
│   │   ├── ALMOST NEVER for objects → NO `copy`
│   │   └── YES only for read-only value types
│   └── Should it be silently discardable?
│       ├── NO for anything holding value → NO `drop`
│       └── YES only for receipts that must be consumed
└── NO → it's a pure data type
    ├── Events → `copy, drop` (ephemeral, emitted then discarded)
    ├── Hot Potato → NO abilities at all
    └── Internal data → decide per use case
```

### 3.2 Our Ability Assignments

| Struct | Abilities | Rationale |
|---|---|---|
| `Vault` | `key` | On-chain shared object, non-transferable once shared |
| `OwnerCap` | `key, store` | Transferable authority object |
| `DelegatedTradingCap` | `key, store` | Transferable bounded authority, **no `copy`** |
| `Balance<T>` (framework) | *none* | Cannot exist independently — must live inside a struct |
| Event structs | `copy, drop` | Ephemeral emission data |

### 3.3 Critical Rule: Never Add `copy` to Capabilities

```move
// ✅ CORRECT: No copy — capability cannot be duplicated
public struct DelegatedTradingCap has key, store { ... }

// ❌ CATASTROPHIC: copy allows unlimited duplication of trading rights
public struct DelegatedTradingCap has key, store, copy { ... }
```

If a capability has `copy`, a compromised agent can clone infinite copies, defeating all quota enforcement. The Move compiler will warn you, but **this is a critical security invariant that must be explicitly called out in code review**.

---

## 4. Balance\<T\> vs Coin\<T\> — The Critical Distinction

### 4.1 Rule: Shared Objects Store Balance\<T\>, Not Coin\<T\>

```move
// ✅ CORRECT: Vault stores Balance<T> internally
public struct Vault has key {
    id: UID,
    // Balances stored as Dynamic Fields: TypeName → Balance<T>
}

// ❌ DANGEROUS: Storing Coin<T> in a shared object
public struct BadVault has key {
    id: UID,
    funds: Coin<SUI>,  // This is a transferable object inside a shared object!
}
```

### 4.2 Why This Matters

| Property | `Balance<T>` | `Coin<T>` |
|---|---|---|
| Abilities | *none* | `key, store` |
| Transferable? | ❌ No | ✅ Yes |
| Can exist standalone? | ❌ Must be inside a struct | ✅ Independent object |
| Safe in shared objects? | ✅ Cannot be extracted without explicit function | ❌ Could be transferred out |
| Use case | Internal accounting | External transfers |

### 4.3 The Conversion Pattern

```move
// Deposit: Coin → Balance (entering the vault)
let balance = coin::into_balance(coin);
balance::join(&mut vault_balance, balance);

// Withdrawal: Balance → Coin (leaving the vault)
let coin = coin::take(&mut vault_balance, amount, ctx);

// Zero-value cleanup
if (coin::value(&coin) == 0) {
    coin::destroy_zero(coin);
};
```

### 4.4 Rule: Coins Are Ephemeral

In our system, `Coin<T>` objects should exist **only within the PTB execution context**:
1. Extracted from `Balance<T>` via `coin::take`
2. Passed to DeepBook for the swap
3. Results immediately converted back to `Balance<T>` via `coin::into_balance`

A `Coin<T>` should **never persist** in the vault between transactions.

---

## 5. Shared Object Best Practices

### 5.1 Minimize Shared Object Interactions

Every interaction with a shared object requires Mysticeti consensus. Minimize the number of shared objects touched per transaction.

```move
// ✅ CORRECT: One vault, one pool — minimum shared objects
public fun execute_swap<BaseAsset, QuoteAsset>(
    vault: &mut Vault,                        // Shared — required
    pool: &mut Pool<BaseAsset, QuoteAsset>,   // Shared — required
    cap: &mut DelegatedTradingCap,            // Owned — fast path
    ...
)

// ❌ WRONG: Unnecessary shared object that could be owned
public fun execute_swap<BaseAsset, QuoteAsset>(
    vault: &mut Vault,
    pool: &mut Pool<BaseAsset, QuoteAsset>,
    config: &mut SharedConfig,  // Why is this shared? Should be a field in Vault
    ...
)
```

### 5.2 Never Lock Global State

```move
// ❌ ANTI-PATTERN: Global state lock
public struct GlobalState has key {
    id: UID,
    locked: bool,  // This creates a global bottleneck
}

// If everyone checks `locked`, every transaction on the protocol
// must go through consensus on this single object.

// ✅ CORRECT: Per-vault state, not global
// Each vault's trading_enabled flag only affects that vault's transactions.
```

### 5.3 Prefer Owned Objects for Authorization

Authorization checks should use owned objects (fast-path) before mutating shared objects (consensus path):

```move
// ✅ CORRECT ORDER: Check owned cap THEN mutate shared vault
public fun execute_swap(
    vault: &mut Vault,    // Shared
    cap: &mut DelegatedTradingCap,  // Owned — checked first by validators
    ...
) {
    authenticate_trade(vault, cap, ...);  // Validates the owned cap
    // Only proceeds to shared object mutation after cap is validated
}
```

---

## 6. Capability Pattern Standards

### 6.1 Capabilities with Embedded State

From Sui Basecamp 2024, the canonical framework for capability design:

```move
// ✅ BEST PRACTICE: Constraints embedded in the capability struct
public struct DelegatedTradingCap has key, store {
    id: UID,
    vault_id: ID,
    expiration_epoch: u64,        // Time-bound
    remaining_trade_volume: u64,   // Quota-limited
    max_trade_size: u64,           // Per-operation ceiling
    version: u64,                  // Version-gated for revocation
}

// ❌ ANTI-PATTERN: "Dumb" capability with no constraints
public struct TradingCap has key, store {
    id: UID,
    vault_id: ID,
    // No limits! Whoever holds this has unlimited trading access!
}

// ❌ ANTI-PATTERN: Hardcoded admin address
const ADMIN: address = @0x123;  // NEVER DO THIS

public fun admin_function(ctx: &TxContext) {
    assert!(tx_context::sender(ctx) == ADMIN, ENotAdmin);
    // This is Solidity thinking. Use capabilities instead.
}
```

### 6.2 Capability Validation Rules

1. **ALWAYS** pass capabilities by reference, not by value (unless destroying):
   ```move
   // ✅ By reference — caller retains the cap
   public fun trade(cap: &mut DelegatedTradingCap, ...)
   
   // ❌ By value — caller loses the cap after one trade
   public fun trade(cap: DelegatedTradingCap, ...)
   ```

2. **ALWAYS** validate `vault_id` linkage:
   ```move
   assert!(cap.vault_id == object::id(vault), EInvalidVault);
   ```

3. **ALWAYS** check version before epoch (cheaper to reject revoked caps early):
   ```move
   assert!(cap.version == vault.version, ECapRevoked);  // Check first
   assert!(cap.expiration_epoch > tx_context::epoch(ctx), ECapExpired);  // Then this
   ```

### 6.3 One-Time-Witness Pattern for Package Init

If we need a one-time initialization guarantee:

```move
/// OTW — the struct name matches the module name in UPPERCASE
/// Has only `drop` ability — can only be used once during init
public struct TIME_LOCKED_VAULT has drop {}

fun init(otw: TIME_LOCKED_VAULT, ctx: &mut TxContext) {
    // This function is called exactly once when the package is published
    // The OTW proves this is the genuine first invocation
}
```

---

## 7. Dynamic Field Usage

### 7.1 Key Type Selection

```move
// ✅ CORRECT: Use TypeName as key for Balance<T> storage
use sui::type_name::{Self, TypeName};

let key = type_name::get<SUI>();
dynamic_field::add(&mut vault.id, key, balance);

// ✅ ALSO CORRECT: Use a custom key struct for domain-specific fields
public struct ConfigKey has copy, drop, store {}
dynamic_field::add(&mut vault.id, ConfigKey {}, config_value);

// ❌ WRONG: Using string keys (no type safety)
dynamic_field::add(&mut vault.id, b"sui_balance", balance);
```

### 7.2 Existence Checks

```move
// ✅ ALWAYS check existence before borrowing
if (dynamic_field::exists_(&vault.id, key)) {
    let balance_ref = dynamic_field::borrow<TypeName, Balance<T>>(&vault.id, key);
    // ...
}

// ❌ NEVER borrow without checking — will abort if field doesn't exist
let balance_ref = dynamic_field::borrow<TypeName, Balance<T>>(&vault.id, key);
```

### 7.3 Dynamic Fields vs Dynamic Object Fields

| Type | Use When | Key Requirements | Value Requirements |
|---|---|---|---|
| `dynamic_field` | Storing non-object values like `Balance<T>`, `u64`, `bool` | `copy + drop + store` | `store` |
| `dynamic_object_field` | Storing objects (things with `key`) that need to remain queryable | `copy + drop + store` | `key + store` |

We use `dynamic_field` because `Balance<T>` is **not** an object — it has no abilities and no UID. It cannot be stored as a dynamic object field.

---

## 8. Error Handling

### 8.1 Error Constant Organization

Group error constants by module and assign sequential values:

```move
// vault.move
const EInvalidCap: u64 = 0;
const ENotOwner: u64 = 1;
const EInsufficientBalance: u64 = 2;

// trading.move
const ECapExpired: u64 = 0;
const EQuotaExceeded: u64 = 1;
const ECapRevoked: u64 = 2;
const EInvalidVault: u64 = 3;
const ETradeTooLarge: u64 = 4;
const ETradingDisabled: u64 = 5;
const ESlippageExceeded: u64 = 6;
```

### 8.2 Assert Patterns

```move
// ✅ CORRECT: Named error constant
assert!(cap.expiration_epoch > tx_context::epoch(ctx), ECapExpired);

// ✅ CORRECT: Descriptive assertion ordering (cheapest first)
assert!(cap.vault_id == object::id(vault), EInvalidVault);   // O(1) ID compare
assert!(vault.trading_enabled, ETradingDisabled);             // O(1) boolean
assert!(cap.version == vault.version, ECapRevoked);           // O(1) integer
assert!(cap.expiration_epoch > tx_context::epoch(ctx), ECapExpired);

// ❌ WRONG: Magic number
assert!(cap.version == vault.version, 42);

// ❌ WRONG: No error context
assert!(amount > 0);  // Which assertion failed? Undebuggable.
```

---

## 9. Function Visibility & Composability

### 9.1 Visibility Levels

```move
// public — callable by anyone, including other packages
public fun create_vault_and_share(...) { ... }

// public(package) — callable only within this package's modules
public(package) fun internal_helper(...) { ... }

// fun (private) - callable only within this module
fun authenticate_trade(...) { ... }

// entry — callable only as a transaction entry point, not composable
// ❌ AVOID entry functions — they break PTB composability
entry fun non_composable_function(...) { ... }
```

### 9.2 Rule: Prefer `public` over `entry`

```move
// ❌ ANTI-PATTERN: entry functions cannot be composed in PTBs
entry fun deposit(vault: &mut Vault, coin: Coin<SUI>) { ... }
// This CANNOT be called mid-PTB after another moveCall

// ✅ CORRECT: public functions are fully composable
public fun deposit<T>(vault: &mut Vault, owner_cap: &OwnerCap, coin: Coin<T>, ctx: &mut TxContext) { ... }
// Can be chained with any other moveCall in a PTB
```

### 9.3 Composability Principle

Functions should accept and return values that can be piped through a PTB:

```move
// ✅ COMPOSABLE: Returns values that the next PTB command can consume
public fun authenticate_and_withdraw<T>(
    vault: &mut Vault,
    cap: &mut DelegatedTradingCap,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): (Coin<T>, Coin<DEEP>) {
    // Returns coins that the next moveCall (DeepBook swap) needs
}

// ❌ NON-COMPOSABLE: Does everything internally, nothing to pipe
public fun execute_trade_internal(...) {
    // Withdraws, swaps, deposits — all in one function
    // Cannot be composed with other protocols
}
```

---

## 10. Hot Potato Pattern Reference

While our vault project does not directly implement a Hot Potato, understanding this pattern is essential for understanding DeepBook V3's flash loan architecture.

### 10.1 What Is a Hot Potato?

A struct with **no abilities at all** — no `key`, `store`, `copy`, or `drop`:

```move
/// A Hot Potato — has NO abilities
public struct FlashLoanReceipt {
    pool_id: ID,
    amount: u64,
}
```

### 10.2 Why It Is Secure

Because it has no `drop` ability, the Move Bytecode Verifier **mathematically guarantees** that:
- It cannot be ignored
- It cannot be stored
- It cannot be copied
- It must be consumed by a function in the originating module

```move
// The only way to destroy the receipt is to call the originating module's repayment function:
public fun return_flash_loan(
    pool: &mut Pool,
    receipt: FlashLoanReceipt,  // Consumed by value
    repayment: Coin<SUI>,
) {
    let FlashLoanReceipt { pool_id, amount } = receipt;  // Destructured and consumed
    assert!(coin::value(&repayment) >= amount);
    // ...
}
```

### 10.3 Key Insight

> "In Solana, flash loan security relies on CPI callbacks and post-execution balance checks — those are runtime guards that can be accidentally omitted. In Move, the Hot Potato pattern makes incorrect usage a **compile-time error**. The Move Bytecode Verifier rejects any transaction that doesn't properly consume the receipt. Security is enforced by the type system, not by the developer's discipline."

---

## 11. Event Emission Standards

### 11.1 Rules

1. **ALWAYS** emit events for state-changing operations:
   ```move
   // ✅ Emit after every significant state change
   event::emit(TradeExecuted { ... });
   event::emit(BalanceChanged { ... });
   ```

2. **ALWAYS** include the object ID in events for indexing:
   ```move
   // ✅ Includes vault_id for filtering
   public struct TradeExecuted has copy, drop {
       vault_id: ID,  // Essential for event filtering
       ...
   }
   ```

3. **ALWAYS** give events `copy + drop` abilities:
   ```move
   // ✅ Correct abilities for events
   public struct VaultCreated has copy, drop { ... }
   
   // ❌ WRONG: Events should not have key or store
   public struct VaultCreated has key, store { ... }
   ```

4. **NEVER** emit events for read-only operations (they don't change state).

---

## 12. Testing Standards

### 12.1 Test Module Structure

```move
#[test_only]
module time_locked_vault::vault_tests;

// ✅ CORRECT: test_only module — code is excluded from publication
// ✅ CORRECT: Named after the module being tested

use sui::test_scenario;
use sui::test_utils;
use sui::clock;
```

### 12.2 Test Helper Functions

```move
#[test_only]
/// Create a standard test setup with vault and owner cap.
/// Used by multiple test functions to reduce boilerplate.
fun setup_vault(scenario: &mut test_scenario::Scenario): (Vault, OwnerCap) {
    let ctx = test_scenario::ctx(scenario);
    vault::create_vault(100, ctx)
}
```

### 12.3 Negative Test Pattern

Every security invariant must have a corresponding negative test:

```move
#[test]
#[expected_failure(abort_code = trading::ECapExpired)]
fun test_expired_cap_is_rejected() {
    // Setup: create cap with expiration_epoch = 5
    // Action: advance to epoch 6, attempt trade
    // Expected: abort with ECapExpired
}
```

### 12.4 Testing Checklist

- [ ] Every `public` function has at least one positive test
- [ ] Every `assert!` has a corresponding `#[expected_failure]` test
- [ ] Multi-epoch scenarios test capability expiration
- [ ] Multi-address scenarios test ownership enforcement
- [ ] Zero-value edge cases are tested (deposit 0, withdraw 0)
- [ ] Cleanup functions are tested (destroy inert caps)

---

## 13. Anti-Patterns to Avoid

### 13.1 Hardcoded Admin Addresses

```move
// ❌ NEVER: Hardcoded addresses for access control
const ADMIN: address = @0xADMIN;
public fun admin_only(ctx: &TxContext) {
    assert!(tx_context::sender(ctx) == ADMIN, ENotAdmin);
}

// ✅ ALWAYS: Capability-based access control
public fun admin_only(owner_cap: &OwnerCap, vault: &mut Vault) {
    assert!(owner_cap.vault_id == object::id(vault), EInvalidCap);
}
```

### 13.2 sender() for Authorization

```move
// ❌ FRAGILE: Relying on tx_context::sender() for authorization
public fun withdraw(vault: &mut Vault, ctx: &TxContext): Coin<SUI> {
    assert!(tx_context::sender(ctx) == vault.owner, ENotOwner);
    // This breaks composability — another protocol can't call this on behalf of the owner
}

// ✅ COMPOSABLE: Relying on capability possession
public fun withdraw(vault: &mut Vault, owner_cap: &OwnerCap, ctx: &mut TxContext): Coin<SUI> {
    assert!(owner_cap.vault_id == object::id(vault), EInvalidCap);
    // Another protocol CAN hold the OwnerCap and call this
}
```

### 13.3 Coin\<T\> in Shared Objects

```move
// ❌ DANGEROUS: Coin<T> stored in a shared object can be transferred out
public struct BadVault has key {
    id: UID,
    funds: Coin<SUI>,  // Has key + store — transferable!
}

// ✅ SAFE: Balance<T> has no abilities — trapped inside the struct
public struct GoodVault has key {
    id: UID,
    // Balance<T> stored via Dynamic Fields — cannot be extracted without our functions
}
```

### 13.4 Unnecessary Global State

```move
// ❌ BOTTLENECK: Global shared state that every transaction touches
public struct Registry has key {
    id: UID,
    total_vaults: u64,           // Every vault creation goes through consensus on this
    total_trades: u64,           // Every trade goes through consensus on this
    global_volume: u64,          // Catastrophic contention
}

// ✅ CORRECT: Per-vault state, tracked off-chain via events
// Events provide the same data without creating on-chain contention
event::emit(TradeExecuted { ... });
```

### 13.5 Reentrancy Guards

```move
// ❌ UNNECESSARY on Sui Move — reentrancy is structurally impossible
public struct Vault has key {
    id: UID,
    locked: bool,  // This is a Solidity/Solana habit — not needed here
}

public fun trade(vault: &mut Vault) {
    assert!(!vault.locked, EReentrant);  // Waste of gas
    vault.locked = true;
    // ... trade logic ...
    vault.locked = false;
}

// ✅ CORRECT: The Move borrow checker enforces exclusive mutable access
// No function can re-enter while another holds &mut Vault
public fun trade(vault: &mut Vault) {
    // ... trade logic ...
    // Reentrancy is impossible at the language level
}
```

---

## 14. Gas Optimization

### 14.1 Minimize Dynamic Field Lookups

```move
// ❌ WASTEFUL: Multiple lookups for the same field
let balance_a = balance_of<SUI>(&vault);  // Lookup 1
let balance_b = balance_of<SUI>(&vault);  // Lookup 2 — redundant!

// ✅ EFFICIENT: Single borrow, multiple operations
let key = type_name::get<T>();
let balance_mut = dynamic_field::borrow_mut<TypeName, Balance<T>>(&mut vault.id, key);
// Do multiple operations on balance_mut
```

### 14.2 Destroy Zero-Value Coins

```move
// ✅ CORRECT: Destroy zero-value coins to avoid unnecessary object creation
if (coin::value(&leftover) == 0) {
    coin::destroy_zero(leftover);
} else {
    deposit_coin(vault, leftover);
};
```

### 14.3 PTB Gas Smashing

On the TypeScript side, leverage the PTB's native gas smashing:

```typescript
// The PTB automatically consolidates dust coins
// when paying for gas, reducing object count
const tx = new Transaction();
tx.setGasBudget(10_000_000); // Explicit gas budget
// Gas smashing happens automatically for gas payment coin selection
```

---

*This document is the authoritative style guide. All code submitted to this repository must conform to these standards. During code review, violations of any rule marked ❌ must be corrected before merge.*
