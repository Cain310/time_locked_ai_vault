# Sui vs Solana — Interview Playbook

## The Definitive Cheat Sheet for a Solana Veteran Interviewing at Mysten Labs

> This document maps **every major Solana architectural pattern** you know to its Sui equivalent. Use this to instantly translate your 5 years of Solana experience into Sui fluency during the interview. Each section includes the Solana pattern, the Sui equivalent, and a **talking point** — the exact angle to present to demonstrate you've internalized the paradigm shift.

---

## Table of Contents

1. [Mental Model Shift: Accounts vs Objects](#1-mental-model-shift-accounts-vs-objects)
2. [Access Control: PDAs vs Capabilities](#2-access-control-pdas-vs-capabilities)
3. [Transaction Model: Instructions vs PTBs](#3-transaction-model-instructions-vs-ptbs)
4. [Composability: CPI vs PTB Piping](#4-composability-cpi-vs-ptb-piping)
5. [Reentrancy: Runtime Guards vs Type System](#5-reentrancy-runtime-guards-vs-type-system)
6. [Flash Loans: Callback Validation vs Hot Potato](#6-flash-loans-callback-validation-vs-hot-potato)
7. [Token Handling: SPL Token vs Coin/Balance](#7-token-handling-spl-token-vs-coinbalance)
8. [State Management: Account Data vs Object Fields](#8-state-management-account-data-vs-object-fields)
9. [Consensus: Single Leader vs Hybrid Path](#9-consensus-single-leader-vs-hybrid-path)
10. [Rent vs Storage Rebates](#10-rent-vs-storage-rebates)
11. [Upgradeability: BPF Loader vs Sui Upgrade Policies](#11-upgradeability-bpf-loader-vs-sui-upgrade-policies)
12. [Client-Side: web3.js vs Sui TypeScript SDK](#12-client-side-web3js-vs-sui-typescript-sdk)
13. [Quick Reference Table](#13-quick-reference-table)
14. [Interview Power Phrases](#14-interview-power-phrases)

---

## 1. Mental Model Shift: Accounts vs Objects

### Solana: Everything Is an Account

```
┌─────────────────────────────────────────┐
│         Solana Account Model            │
│                                         │
│  Account = byte array at an address     │
│  ├── owner: Program ID                  │
│  ├── lamports: u64                      │
│  ├── data: Vec<u8>  ← you serialize    │
│  └── executable: bool                   │
│                                         │
│  All accounts are flat, no hierarchy    │
│  Program doesn't "own" data — it has    │
│  write permission to accounts assigned  │
│  to it via the owner field.             │
└─────────────────────────────────────────┘
```

### Sui: Everything Is an Object

```
┌─────────────────────────────────────────┐
│         Sui Object Model                │
│                                         │
│  Object = typed struct with UID         │
│  ├── id: UID (globally unique)          │
│  ├── typed fields (not raw bytes!)      │
│  ├── abilities: key, store, copy, drop  │
│  └── ownership: Owned | Shared | Wrapped│
│                                         │
│  Objects have hierarchy — objects can    │
│  own other objects. Type system enforces │
│  what operations are valid.             │
└─────────────────────────────────────────┘
```

### 💡 Talking Point

> "On Solana, I spent significant effort serializing and deserializing account data, managing account sizes, and tracking account ownership through program IDs. On Sui, the struct IS the data — the Move type system replaces manual serialization with compile-time type safety. An `OwnerCap` isn't a byte array I have to decode; it's a first-class typed object that the runtime understands natively."

---

## 2. Access Control: PDAs vs Capabilities

### Solana: Program Derived Addresses

```rust
// Solana: Derive a PDA for the vault authority
let (vault_authority, bump) = Pubkey::find_program_address(
    &[b"vault", user.key().as_ref()],
    &program_id
);

// Delegation requires a separate data account
#[account]
pub struct DelegationAccount {
    pub delegate: Pubkey,        // Who can trade
    pub expiry_slot: u64,        // When it expires
    pub remaining_volume: u64,   // How much they can trade
    pub vault: Pubkey,           // Which vault
    pub bump: u8,                // PDA bump seed
}

// Trade instruction must validate everything manually
pub fn execute_trade(ctx: Context<ExecuteTrade>, amount: u64) -> Result<()> {
    let delegation = &ctx.accounts.delegation;
    
    // Manual checks — each one is a potential bug if forgotten
    require!(delegation.delegate == ctx.accounts.signer.key(), ErrorCode::Unauthorized);
    require!(Clock::get()?.slot < delegation.expiry_slot, ErrorCode::Expired);
    require!(delegation.remaining_volume >= amount, ErrorCode::QuotaExceeded);
    
    // CPI into DEX with vault PDA as signer
    invoke_signed(
        &swap_instruction,
        &[vault_account, token_account, dex_program],
        &[&[b"vault", user.as_ref(), &[bump]]],  // PDA seeds for signing
    )?;
    
    Ok(())
}
```

### Sui: Capability Objects

```move
// Sui: The capability IS the authorization
public struct DelegatedTradingCap has key, store {
    id: UID,
    vault_id: ID,
    expiration_epoch: u64,
    remaining_trade_volume: u64,
    max_trade_size: u64,
    version: u64,
}

// Delegation: just mint and transfer
public fun mint_delegated_trading_cap(
    vault: &Vault,
    owner_cap: &OwnerCap,
    delegate: address,
    ...
) {
    let cap = DelegatedTradingCap { ... };
    transfer::public_transfer(cap, delegate);
}

// Trade: pass the cap — it IS the proof
public fun execute_swap(
    vault: &mut Vault,
    cap: &mut DelegatedTradingCap,  // Possession = authorization
    ...
) {
    assert!(cap.vault_id == object::id(vault), EInvalidVault);
    assert!(cap.version == vault.version, ECapRevoked);
    assert!(cap.expiration_epoch > tx_context::epoch(ctx), ECapExpired);
    // All constraints are struct fields — no separate data account needed
}
```

### Side-by-Side

| Aspect | Solana PDA | Sui Capability |
|---|---|---|
| **Identity proof** | Seed derivation + bump validation | Object possession |
| **Constraint storage** | Separate data account (another PDA or keypair) | Embedded in the capability struct |
| **Delegation** | Create data account, write delegate pubkey | `transfer::public_transfer(cap, delegate)` |
| **Revocation** | Find account, zero data, close, reclaim rent | Increment version counter — O(1), instant |
| **Transfer rights** | Rewrite account data + change authority | `transfer::public_transfer` — one function |
| **Composability** | Other programs need CPI + seed knowledge | Other protocols just need a `&OwnerCap` reference |

### 💡 Talking Point

> "In Solana, a PDA is a *derived address* — it's a cryptographic trick that allows a program to sign. But it's not a meaningful entity; the authorization logic lives in a separate data account that I have to create, fund, serialize, and manually validate. In Sui, a capability is a *tangible object* with typed fields. Delegation is `transfer`. Revocation is a version bump. The security model is in the struct definition, not in the instruction handler."

---

## 3. Transaction Model: Instructions vs PTBs

### Solana: Flat Instruction Array

```typescript
// Solana: Transaction with ordered instructions
const tx = new Transaction();

// Must declare ALL accounts upfront for EVERY instruction
tx.add(
    new TransactionInstruction({
        keys: [
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: tokenAccount, isSigner: false, isWritable: true },
            { pubkey: dexProgram, isSigner: false, isWritable: false },
            // ... 8+ more accounts
        ],
        programId: myProgram,
        data: Buffer.from([/* serialized instruction data */]),
    })
);

// LIMITATION: Instructions cannot share intermediate results
// Each instruction operates independently on accounts
// If instruction 2 needs a value from instruction 1,
// instruction 1 must write it to an account that instruction 2 reads
```

### Sui: Programmable Transaction Blocks

```typescript
// Sui: PTB with piped results
const tx = new Transaction();

// Step 1: Returns values that Step 2 can consume directly
const [baseCoin, deepCoin] = tx.moveCall({
    target: `${PKG}::trading::authenticate_and_withdraw`,
    arguments: [tx.object(vault), tx.object(cap), tx.pure.u64(amount), tx.object('0x6')],
});

// Step 2: Uses outputs from Step 1 — no intermediate storage needed
const [leftover, received, deepLeft] = tx.moveCall({
    target: '@mysten/deepbook-v3::pool::swap_exact_base_for_quote',
    arguments: [tx.object(pool), baseCoin, deepCoin, tx.pure.u64(minOut), tx.object('0x6')],
});

// Step 3: Consumes outputs from Step 2
tx.moveCall({
    target: `${PKG}::trading::deposit_swap_results`,
    arguments: [tx.object(vault), leftover, received, deepLeft],
});

// Up to 1,024 commands per PTB — all atomic
```

### Key Differences

| Property | Solana Transaction | Sui PTB |
|---|---|---|
| **Max operations** | ~10-20 instructions (CU limited) | 1,024 commands |
| **Result sharing** | Via account state only | Direct result piping between commands |
| **Account declaration** | All upfront in transaction header | Per-command with dynamic resolution |
| **Atomicity** | All-or-nothing per transaction | All-or-nothing per PTB |
| **Gas model** | Per-instruction CU + priority fees | Unified gas budget per PTB |
| **Composability** | CPI chains (nested calls) | Sequential commands (flat pipeline) |

### 💡 Talking Point

> "Solana's instruction array model forces you to declare all accounts upfront and communicate between instructions through account state mutations. The PTB model lets me pipe values directly — the output of `authenticate_and_withdraw` flows into `swap_exact_base_for_quote` without touching storage. It's like Unix pipes for on-chain operations. And I get 1,024 commands versus Solana's effective ~10-instruction limit before hitting compute unit ceilings."

---

## 4. Composability: CPI vs PTB Piping

### Solana: Cross-Program Invocation (CPI)

```rust
// Solana: Program A calls Program B via CPI
// Program A must:
//   1. Know Program B's program ID
//   2. Construct the instruction data
//   3. Provide all required accounts
//   4. Handle the CPI stack depth (max 4 levels)

pub fn trade_via_dex(ctx: Context<Trade>, amount: u64) -> Result<()> {
    // Build CPI accounts
    let cpi_accounts = DexSwap {
        pool: ctx.accounts.dex_pool.to_account_info(),
        user_source: ctx.accounts.user_token_a.to_account_info(),
        user_dest: ctx.accounts.user_token_b.to_account_info(),
        authority: ctx.accounts.vault_authority.to_account_info(),
    };
    
    // Sign with PDA seeds
    let seeds = &[b"vault", user.as_ref(), &[bump]];
    let signer = &[&seeds[..]];
    
    // Execute CPI — this YIELDS execution context to the DEX program
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.dex_program.to_account_info(),
        cpi_accounts,
        signer,
    );
    dex_program::swap(cpi_ctx, amount)?;
    
    // Execution returns here — we hope the DEX did the right thing
    // We must manually verify post-state if we don't trust the DEX
    
    Ok(())
}
```

### Sui: PTB Command Piping

```typescript
// Sui: Client constructs the full execution plan
const tx = new Transaction();

// No CPI — the client chains commands declaratively
const coin = tx.moveCall({ target: `${PKG}::vault::withdraw`, ... });
const [out1, out2, out3] = tx.moveCall({ target: `deepbook::pool::swap`, arguments: [coin, ...] });
tx.moveCall({ target: `${PKG}::vault::deposit`, arguments: [out1, out2, out3] });

// The execution plan is fully visible, auditable, and atomic
// No hidden CPI calls, no stack depth limits, no context switching
```

### The Paradigm Shift

```
Solana CPI Model:
  Program A  ──CPI──▶  Program B  ──CPI──▶  Program C
  (depth 1)            (depth 2)              (depth 3)
  ⚠️ Max 4 levels deep
  ⚠️ Each program yields execution context
  ⚠️ Post-state must be verified on return

Sui PTB Model:
  Command 1 ──pipe──▶ Command 2 ──pipe──▶ Command 3 ──pipe──▶ ...
  (flat)              (flat)               (flat)
  ✅ Up to 1,024 commands
  ✅ No context yielding — sequential execution
  ✅ Client sees the full plan before signing
```

### 💡 Talking Point

> "CPIs are fundamentally about programs calling programs — it's a nested stack model with depth limits and context switching overhead. PTBs flip this: the client is the orchestrator. I construct a flat pipeline that chains Move function calls with result piping. There's no stack depth limit, no context switching, and the entire execution plan is visible and auditable before the transaction is even signed. Composability moves from the smart contract layer to the client layer."

---

## 5. Reentrancy: Runtime Guards vs Type System

### Solana: Explicit Reentrancy Protection

```rust
// Solana: You MUST add reentrancy guards manually
#[account]
pub struct Vault {
    pub locked: bool,  // Reentrancy guard
    pub balance: u64,
}

pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    
    // Check lock
    require!(!vault.locked, ErrorCode::Reentrancy);
    vault.locked = true;  // Lock
    
    // Dangerous: CPI to external program while vault is mutable
    invoke(
        &transfer_instruction(amount),
        &[ctx.accounts.token_program.to_account_info()],
    )?;
    
    vault.balance -= amount;
    vault.locked = false;  // Unlock
    
    Ok(())
}
// ⚠️ If you forget the lock, or if the CPI callback can manipulate
//    the vault account, you have a classic reentrancy vulnerability.
```

### Sui: Structurally Impossible

```move
// Sui: Reentrancy is impossible at the language level
public fun withdraw(vault: &mut Vault, amount: u64, ctx: &mut TxContext): Coin<SUI> {
    // The &mut Vault reference is EXCLUSIVE
    // No other function can access vault while this function holds &mut
    // The Move borrow checker enforces this at COMPILE TIME
    
    let coin = extract_coin<SUI>(vault, amount, ctx);
    // Even if we call another function, vault is still borrowed here
    // No "callback" can re-enter this function with &mut vault
    coin
}
```

### Why It's Impossible in Move

The Move **borrow checker** enforces:
1. At most **one mutable reference** (`&mut`) to an object at any time
2. **No mutable reference can coexist** with any other reference to the same object
3. These rules are checked at **compile time** by the Move Bytecode Verifier

This means:
- While `withdraw` holds `&mut Vault`, no other code can access the vault
- There is no CPI mechanism that could re-enter with access to the same vault
- PTB commands execute **sequentially** — the next command doesn't start until the previous one completes and releases its references

### 💡 Talking Point

> "On Solana, I've written hundreds of reentrancy guards — `locked` booleans, Anchor's `#[account(constraint)]` patterns, instruction introspection. They're all runtime checks that cost compute units and rely on the developer remembering to add them. On Move, the borrow checker makes reentrancy a **type error**. It's not that we add a guard; it's that the attack vector literally cannot be expressed in the language. When I show my vault code has no reentrancy guards, it's not because I forgot — it's because the compiler guarantees they're unnecessary."

---

## 6. Flash Loans: Callback Validation vs Hot Potato

### Solana: Post-State Verification

```rust
// Solana flash loan: relies on instruction introspection
pub fn borrow_flash(ctx: Context<FlashBorrow>, amount: u64) -> Result<()> {
    // Transfer tokens to borrower
    transfer(ctx.accounts.pool, ctx.accounts.borrower, amount)?;
    
    // ⚠️ At this point, the borrower's program runs arbitrary code
    // ⚠️ We have NO guarantee they'll return the funds
    // ⚠️ We rely on a SEPARATE "repay" instruction being in the same tx
    
    // Some implementations use instruction introspection to scan
    // the transaction for a repay instruction — fragile and gas-heavy
    
    Ok(())
}

pub fn repay_flash(ctx: Context<FlashRepay>, amount: u64) -> Result<()> {
    // Verify the correct amount was returned
    // This is a RUNTIME check — if the borrow instruction didn't
    // properly track state, this can be bypassed
    
    Ok(())
}
```

### Sui: Hot Potato — Compile-Time Guarantee

```move
// Sui: The receipt MUST be consumed — enforced by the compiler
public struct FlashLoanReceipt {
    // NO abilities — not key, store, copy, or drop
    pool_id: ID,
    amount: u64,
}

public fun borrow(pool: &mut Pool, amount: u64): (Coin<SUI>, FlashLoanReceipt) {
    let coin = extract(pool, amount);
    let receipt = FlashLoanReceipt { pool_id: object::id(pool), amount };
    (coin, receipt)
    // The receipt is now a "hot potato" — the caller MUST deal with it
}

public fun repay(pool: &mut Pool, receipt: FlashLoanReceipt, payment: Coin<SUI>) {
    let FlashLoanReceipt { pool_id, amount } = receipt;  // Consumed!
    assert!(pool_id == object::id(pool));
    assert!(coin::value(&payment) >= amount);
    deposit(pool, payment);
}
// If the caller doesn't call repay(), the Move compiler REJECTS the transaction
// This is not a runtime check — it's a COMPILE-TIME guarantee
```

### Comparison

| Security Property | Solana | Sui (Hot Potato) |
|---|---|---|
| Repayment guarantee | Runtime balance check | **Compile-time type enforcement** |
| Can borrower ignore receipt? | Yes (if no introspection) | **No — compiler rejects the code** |
| Reentrancy risk | High — CPI yields context | Non-existent — no CPI model |
| Developer burden | Must add introspection logic | Zero — correct by construction |
| Gas overhead | Instruction scanning costs CU | Zero — no runtime checks needed |

### 💡 Talking Point

> "This is the single most powerful example of Move's security model. In Solana flash loans, security is a *hope* backed by runtime checks. In Sui, the Hot Potato pattern makes it a *mathematical certainty* backed by the compiler. The FlashLoanReceipt has no abilities — it cannot be dropped, stored, or copied. The only thing you can do with it is pass it back to the repayment function. If you don't, your code doesn't compile. Full stop."

---

## 7. Token Handling: SPL Token vs Coin/Balance

### Solana: SPL Token Program

```rust
// Solana: Tokens are accounts owned by the Token Program
// Token Account layout:
//   mint: Pubkey (32 bytes)
//   owner: Pubkey (32 bytes)  
//   amount: u64 (8 bytes)
//   delegate: Option<Pubkey>
//   state: AccountState
//   ...

// To transfer: CPI into Token Program
invoke(
    &spl_token::instruction::transfer(
        &token_program_id,
        &source_token_account,
        &destination_token_account,
        &authority,
        &[],
        amount,
    )?,
    &[source, destination, authority, token_program],
)?;

// ⚠️ You must:
//   1. Create Associated Token Accounts (ATA) for recipients
//   2. Handle token account rent exemption
//   3. Deal with account close authority
//   4. Manage delegate authority for approval-based transfers
```

### Sui: Native Coin and Balance Types

```move
// Sui: Tokens are typed objects — no separate "Token Program"

// Coin<T> — a transferable token object
// Has key + store abilities — can be owned, transferred, stored
let coin: Coin<SUI> = coin::take(&mut balance, 1000, ctx);
transfer::public_transfer(coin, recipient);

// Balance<T> — raw fungible value, NOT an object
// Has NO abilities — cannot exist independently
// Perfect for internal accounting in shared objects
let balance: Balance<SUI> = coin::into_balance(coin);
balance::join(&mut vault_balance, balance);

// Splitting and merging is native
let half = balance::split(&mut balance, 500);
balance::join(&mut balance, half);

// No ATA creation, no rent, no delegate authority, no CPI
```

### Comparison

| Operation | Solana | Sui |
|---|---|---|
| **Create token account** | `create_associated_token_account` CPI | Not needed — coins are standalone objects |
| **Transfer** | CPI into Token Program | `transfer::public_transfer(coin, addr)` |
| **Split** | Not natively supported — requires temp accounts | `coin::split(&mut coin, amount, ctx)` |
| **Merge** | Not natively supported — close and recreate | `coin::join(&mut coin_a, coin_b)` |
| **Internal accounting** | Manually track in data accounts | `Balance<T>` — type-safe, non-transferable |
| **Type safety** | Runtime mint address verification | Compile-time generic `T` enforcement |

### 💡 Talking Point

> "On Solana, tokens are byte arrays in accounts owned by the Token Program. Every operation is a CPI. You manage ATAs, rent, delegates, and account closes manually. On Sui, `Coin<SUI>` is a typed object I can split, merge, transfer, and pipe through a PTB — all with native language operations. And `Balance<T>` gives me something Solana doesn't have at all: a non-transferable value type for safe internal accounting in shared objects."

---

## 8. State Management: Account Data vs Object Fields

### Solana: Manual Serialization

```rust
// Solana: You define the data layout and serialize manually
#[account]
pub struct VaultState {
    pub authority: Pubkey,       // 32 bytes
    pub total_deposits: u64,     // 8 bytes
    pub is_active: bool,         // 1 byte
    // Total: 41 bytes — must declare space at account creation
}

// Account creation requires knowing the exact byte size
let space = 8 + 32 + 8 + 1; // 8 for discriminator + fields
let rent = Rent::get()?.minimum_balance(space);
create_account(payer, vault, rent, space, program_id);

// Deserialization happens on every instruction call
// Serialization happens on every instruction return
// ⚠️ Account size is FIXED at creation — cannot grow
```

### Sui: Typed Object Fields

```move
// Sui: The struct IS the state — no serialization
public struct Vault has key {
    id: UID,
    version: u64,
    max_slippage_bps: u64,
    trading_enabled: bool,
    // Dynamic Fields allow unbounded growth
}

// Creating an object — size is determined by the struct
let vault = Vault {
    id: object::new(ctx),
    version: 0,
    max_slippage_bps: 100,
    trading_enabled: true,
};
transfer::share_object(vault);

// Adding new data types later — Dynamic Fields grow the object
dynamic_field::add(&mut vault.id, key, new_data);
// No reallocation, no migration, no space planning
```

### 💡 Talking Point

> "In Solana, account space is allocated at creation time and fixed forever. If your vault needs to store a new asset type, you're looking at account migration or auxiliary accounts. In Sui, Dynamic Fields let me attach arbitrary new data to an object at any time. My vault started with SUI balances, and I added USDC and DEEP support by simply calling `dynamic_field::add`. No redeployment, no migration, no reallocation."

---

## 9. Consensus: Single Leader vs Hybrid Path

### Solana: Single Leader Block Production

```
Solana Consensus:
  
  Slot 1: Leader A produces block
  Slot 2: Leader B produces block  
  ...
  
  ALL transactions go through the same leader
  ALL transactions compete for the same 48M CU block space
  Priority fees determine ordering within a block
  
  ⚠️ Single bottleneck: leader processing capacity
  ⚠️ All state transitions must be sequenced by one leader
```

### Sui: Hybrid Consensus Paths

```
Sui Consensus:
  
  Owned Object TX → Byzantine Consistent Broadcast
    ├── No leader needed
    ├── Validators individually verify ownership
    ├── ~400ms finality
    └── No contention with other transactions
  
  Shared Object TX → Mysticeti DAG Consensus
    ├── DAG-based block structure (not single-chain)
    ├── Only shared objects require sequencing
    ├── Other shared objects don't contend unless same object
    └── ~600ms finality

  Hybrid TX (our case) → Fast-path + Mysticeti
    ├── DelegatedTradingCap validated via fast-path
    ├── Vault + Pool sequenced via Mysticeti
    └── Fast-path acts as a pre-filter
```

### 💡 Talking Point

> "Solana has a single execution pipeline — every transaction, whether it's a simple transfer or a complex DeFi operation, goes through the same leader and competes for the same compute units. Sui separates the paths: our agent's `DelegatedTradingCap` is validated via fast-path broadcast with sub-second finality, and only the vault and pool mutations need Mysticeti consensus. It's not just faster — it's architecturally impossible for a memecoin mint to delay our DeFi trade because they're on different consensus paths."

---

## 10. Rent vs Storage Rebates

### Solana: Perpetual Rent Exemption

```rust
// Solana: Every account needs rent-exempt SOL
let rent = Rent::get()?.minimum_balance(account_size);
// ~0.00089 SOL per account (varies by size)

// To close an account and recover rent:
**vault_account.try_borrow_mut_lamports()? -= lamports;
**recipient.try_borrow_mut_lamports()? += lamports;

// ⚠️ Must manually zero account data to prevent dead references
// ⚠️ Must handle "close account" carefully to avoid rent sniping
// ⚠️ Associated Token Accounts accumulate rent across all token types
```

### Sui: Storage Fee with Rebates

```move
// Sui: Pay once at object creation, get refund at deletion
let vault = Vault { id: object::new(ctx), ... };
// Storage fee is automatically charged from gas

// When an object is deleted:
object::delete(id);
// Storage rebate is automatically returned to transaction sender

// For our capability cleanup:
public fun destroy_inert_cap(cap: DelegatedTradingCap) {
    let DelegatedTradingCap { id, .. } = cap;
    object::delete(id);
    // Rebate returned automatically — no manual lamport calculation
}
```

### 💡 Talking Point

> "Solana's rent model means every delegation I create costs lamports that I have to manually reclaim when the delegation expires. On Sui, I pay a storage fee when I create the `DelegatedTradingCap`, and when the agent or anyone cleans up the expired cap, the storage rebate is automatically returned. There's actually a gas incentive for cleanup — the rebate offsets the transaction gas cost."

---

## 11. Upgradeability: BPF Loader vs Sui Upgrade Policies

### Solana

```rust
// Solana: Programs are upgradeable by default via BPF Loader
// The upgrade authority can change any instruction logic
// To make immutable: set upgrade authority to None

// ⚠️ No granular upgrade control
// ⚠️ Binary choice: upgradeable or frozen
```

### Sui

```move
// Sui: UpgradeCap grants upgrade authority
// Published with the package — transferred to the publisher

// Upgrade policies (granular control):
// - Compatible: Can add new functions, cannot change existing signatures
// - Additive: Can add new modules, cannot modify existing modules  
// - Dependency-only: Can only change dependencies
// - Immutable: Fully frozen — destroy the UpgradeCap

// Enforce immutability:
transfer::public_freeze_object(upgrade_cap);
// Or restrict policy:
package::only_additive_upgrades(&mut upgrade_cap);
```

### 💡 Talking Point

> "Solana's upgrade model is binary — the program is either mutable or frozen. On Sui, the `UpgradeCap` provides granular upgrade policies. For our vault, we can allow additive upgrades — new modules for new DEX integrations — while making existing capability logic immutable. This is production-grade governance that Solana doesn't offer natively."

---

## 12. Client-Side: web3.js vs Sui TypeScript SDK

### Solana

```typescript
// Solana: Manual account management and instruction building
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

const ix = new TransactionInstruction({
    keys: [
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: tokenAccountA, isSigner: false, isWritable: true },
        { pubkey: tokenAccountB, isSigner: false, isWritable: true },
        { pubkey: dexPool, isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: true, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        // 6+ accounts, each with manual isSigner/isWritable flags
    ],
    programId: myProgramId,
    data: Buffer.from(borsh.serialize(schema, instructionData)),
});

const tx = new Transaction().add(ix);
await sendAndConfirmTransaction(connection, tx, [payer]);
```

### Sui

```typescript
// Sui: Typed, composable, with MVR human-readable routing
import { Transaction } from '@mysten/sui/transactions';
import { namedPackagesPlugin } from '@mysten/mvr-static';

Transaction.registerGlobalPlugin(namedPackagesPlugin({ suiClient: client }));

const tx = new Transaction();

// Human-readable target, typed arguments, result piping
const [coin, deep] = tx.moveCall({
    target: '@your-org/time-locked-vault::trading::authenticate_and_withdraw',
    typeArguments: ['0x2::sui::SUI', '0xUSDC::usdc::USDC'],
    arguments: [
        tx.object(vaultId),
        tx.object(capId),
        tx.pure.u64(1000000),
        tx.object('0x6'),
    ],
});

// Result piping — no intermediate accounts
const [left, received, deepLeft] = tx.moveCall({
    target: '@mysten/deepbook-v3::pool::swap_exact_base_for_quote',
    arguments: [tx.object(poolId), coin, deep, tx.pure.u64(minOut), tx.object('0x6')],
});

// Dry run before execution
const dryRun = await client.dryRunTransactionBlock({
    transactionBlock: await tx.build({ client }),
});

await client.signAndExecuteTransaction({ signer: keypair, transaction: tx });
```

### 💡 Talking Point

> "The Sui TypeScript SDK with MVR is a generational leap over Solana's web3.js. I call `@mysten/deepbook-v3::pool::swap_exact_base_for_quote` — a human-readable target that MVR resolves to the latest on-chain address. I pipe results between commands without intermediate accounts. And I can dry-run the entire PTB to verify execution before spending gas. This is the developer experience that makes Sui compelling for production DeFi."

---

## 13. Quick Reference Table

| Solana Concept | Sui Equivalent | Key Difference |
|---|---|---|
| Account | Object | Typed struct vs byte array |
| Program | Move Package/Module | Type-safe vs manual serialization |
| PDA | Not needed | Capabilities replace derived addresses |
| CPI | PTB command piping | Client orchestration vs nested calls |
| SPL Token Account | `Coin<T>` | Native type vs program-owned account |
| Token balance in vault | `Balance<T>` | Non-transferable value type |
| Instruction | PTB moveCall | Up to 1,024 per block with result piping |
| Compute Units (200K-1.4M) | Gas budget (unified) | No per-instruction fragmentation |
| Reentrancy guard | Not needed | Borrow checker prevents reentrancy |
| `is_signer` / `is_writable` | Object ownership model | Implicit from Owned vs Shared |
| Account rent | Storage fee + rebate | Pay once, refund on deletion |
| Program upgrade authority | `UpgradeCap` with policies | Granular vs binary control |
| Anchor `#[account]` | `public struct ... has key` | Move abilities vs attribute macros |
| `Clock` sysvar | `sui::clock::Clock` | Object at address `0x6` |
| `Rent` sysvar | Not needed | No perpetual rent model |
| Priority fees | Gas price | Simpler model |
| Lookup tables (ALTs) | Not needed | PTBs handle dynamic object references |
| `invoke_signed` with seeds | `transfer::public_transfer` | Direct transfer vs PDA signing |

---

## 14. Interview Power Phrases

Use these to demonstrate paradigm fluency during the code walkthrough:

### On Capabilities
> "The `DelegatedTradingCap` is not an access control *check* — it's an access control *object*. Possession is proof. No seed derivation, no account lookup, no signature verification beyond what validators do natively."

### On Balance vs Coin
> "We use `Balance<T>` inside the vault because it has zero abilities — it physically cannot leave the struct without explicit extraction. This is a stronger guarantee than any Solana runtime check."

### On the Version Counter
> "Revocation is O(1). I increment one integer and every outstanding delegation becomes invalid. On Solana, I'd need to iterate over every delegation PDA and close them individually — O(n) gas that scales with the number of delegates."

### On PTBs
> "The PTB is the orchestration layer. On Solana, complex DeFi flows require intermediate state accounts and nested CPI chains. Here, I construct a flat pipeline on the client — the smart contract stays lean because the composition happens at the transaction level."

### On Reentrancy
> "There are no reentrancy guards in this codebase. That's not an omission — it's a feature. The Move borrow checker gives us exclusive mutable access. Reentrancy is a type error, not a runtime vulnerability."

### On Hot Potato (if discussing DeepBook)
> "The `FlashLoanReceipt` has no abilities — no key, no store, no copy, no drop. The compiler literally rejects any code path that doesn't consume it through the repayment function. This is security at the type system level — something fundamentally impossible in Solana's account model."

### On MVR
> "I use `@mysten/deepbook-v3` as MY target instead of a 64-character hex address. The MVR plugin resolves it at build time. This means when DeepBook upgrades their package, my client code automatically routes to the latest version without a code change. Manos built this system specifically to solve the version management problem in PTB construction."

---

*This playbook is your translation layer. Every Solana pattern you know has a Sui equivalent that's either simpler, safer, or more composable — usually all three. Lead with the capability pattern, demonstrate the PTB pipeline, and let the type system speak for itself.*
