/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * manage_vault.ts — Vault management operations (delegation, revocation, queries)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This script demonstrates the owner's management lifecycle:
 *   1. Mint a DelegatedTradingCap for an AI agent
 *   2. Query vault state and dynamic fields
 *   3. Revoke all delegations (O(1) version bump)
 *   4. Toggle trading enabled/disabled
 *   5. Destroy an inert (revoked) cap to reclaim storage rebate
 *
 * Usage:
 *   export SUI_PRIVATE_KEY="suiprivkey1..."
 *   export PACKAGE_ID="0x..."
 *   export VAULT_ID="0x..."
 *   export OWNER_CAP_ID="0x..."
 *   npx tsx manage_vault.ts
 *
 * ─── SOLANA COMPARISON ───
 * On Solana, delegation would typically involve:
 *   1. Creating a PDA with the delegate's pubkey stored in it
 *   2. Revocation requires iterating over and closing delegate PDAs
 *   3. Or a central "delegate registry" account with a Vec<Pubkey>
 *
 * On Sui, delegation creates a transferable capability OBJECT. Revocation
 * is O(1) — just bump the vault's version counter. No iteration needed.
 * The capabilities become instantly invalid because their version snapshot
 * no longer matches the vault's current version.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

// ═══════════════════════════════════════════════════════
// CONFIGURATION (from deploy.ts output or environment)
// ═══════════════════════════════════════════════════════

const NETWORK: 'testnet' | 'devnet' | 'mainnet' = 'testnet';

/** Load required environment variables with validation */
function loadConfig() {
    const required = ['PACKAGE_ID', 'VAULT_ID', 'OWNER_CAP_ID', 'SUI_PRIVATE_KEY'] as const;
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        console.error(`ERROR: Missing environment variables: ${missing.join(', ')}`);
        console.error('Run deploy.ts first and export the output variables.');
        process.exit(1);
    }

    return {
        packageId: process.env.PACKAGE_ID!,
        vaultId: process.env.VAULT_ID!,
        ownerCapId: process.env.OWNER_CAP_ID!,
        privateKey: process.env.SUI_PRIVATE_KEY!,
    };
}

/** Address to delegate trading authority to (the "AI agent") */
const AGENT_ADDRESS =
    process.env.AGENT_ADDRESS ?? '0x0000000000000000000000000000000000000000000000000000000000000bad';

// ═══════════════════════════════════════════════════════
// OPERATION 1: MINT DELEGATED TRADING CAP
// ═══════════════════════════════════════════════════════

/**
 * Mint a DelegatedTradingCap and send it to the AI agent.
 *
 * ─── MOVE FUNCTION BEING CALLED ───
 * ```move
 * public fun mint_delegated_trading_cap(
 *     vault: &Vault,                  // Immutable reference — read-only
 *     owner_cap: &OwnerCap,           // Immutable reference — proves ownership
 *     delegate: address,              // Recipient of the new cap
 *     expiration_epoch: u64,          // Epoch after which cap expires
 *     trade_volume_limit: u64,        // Total volume allowed
 *     max_trade_size: u64,            // Per-trade size ceiling
 *     ctx: &mut TxContext,            // Auto-injected
 * )
 * ```
 *
 * ─── KEY DESIGN DECISION: IMMUTABLE REFERENCES ───
 * Notice that `vault` and `owner_cap` are both `&` (immutable refs), not `&mut`.
 * This means:
 *   - Multiple mint operations CAN run concurrently (no write contention)
 *   - The vault is accessed via consensus (Shared Object), but only for reading
 *   - This is a deliberate optimization for the delegation-heavy use case
 *
 * On Solana, you'd have to declare the vault account as `mut` in the Accounts
 * struct even if you only need to read it, because Anchor doesn't distinguish
 * between read intent and write intent at the account level (only at the
 * constraint level with `#[account(mut)]`).
 *
 * ─── THE CAPABILITY PATTERN ───
 * Instead of storing "who is authorized" inside the vault (like Solana PDAs),
 * we CREATE an authorization object and GIVE it to the delegate. Authorization
 * is proven by possession, not by looking up a registry. This is the core
 * Sui Object-Centric design pattern.
 */
async function mintDelegatedTradingCap(
    client: SuiJsonRpcClient,
    signer: Ed25519Keypair,
    packageId: string,
    vaultId: string,
    ownerCapId: string,
): Promise<string | null> {
    console.log('═══════════════════════════════════════════════════════');
    console.log('OPERATION 1: Minting DelegatedTradingCap...');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  Delegate (AI Agent): ${AGENT_ADDRESS}`);

    const tx = new Transaction();

    // ─── Get current epoch to calculate expiration ───
    // We'll set expiration to current epoch + 100 (generous time window).
    // On testnet, epochs are ~24 hours.
    const epochInfo = await client.getLatestSuiSystemState();
    const currentEpoch = Number(epochInfo.epoch);
    const expirationEpoch = currentEpoch + 100;

    console.log(`  Current Epoch: ${currentEpoch}`);
    console.log(`  Expiration Epoch: ${expirationEpoch}`);
    console.log(`  Trade Volume Limit: 5 SUI (5,000,000,000 MIST)`);
    console.log(`  Max Trade Size: 1 SUI (1,000,000,000 MIST)`);

    // ─── moveCall: capabilities::mint_delegated_trading_cap ───
    //
    // Arguments mapping:
    //   vault: &Vault         → tx.object(vaultId)      — Shared Object, immutable ref
    //   owner_cap: &OwnerCap  → tx.object(ownerCapId)   — Owned Object, immutable ref
    //   delegate: address     → tx.pure.address(...)     — Pure value (not an object)
    //   expiration_epoch: u64 → tx.pure.u64(...)         — Pure value
    //   trade_volume_limit    → tx.pure.u64(...)         — 5 SUI in MIST
    //   max_trade_size: u64   → tx.pure.u64(...)         — 1 SUI in MIST
    //   ctx: &mut TxContext   → (auto-injected)
    //
    // ─── SOLANA COMPARISON: Pure Values vs Account Inputs ───
    // On Solana, every input is either an Account or instruction data (Borsh bytes).
    // On Sui, inputs are either Objects (tx.object) or Pure values (tx.pure.*).
    // - Objects are on-chain entities with IDs and ownership
    // - Pure values are scalar data (numbers, addresses, booleans, vectors)
    // The runtime validates that object references match the function's expected types.
    tx.moveCall({
        target: `${packageId}::capabilities::mint_delegated_trading_cap`,
        arguments: [
            tx.object(vaultId),                    // &Vault
            tx.object(ownerCapId),                 // &OwnerCap
            tx.pure.address(AGENT_ADDRESS),        // delegate: address
            tx.pure.u64(expirationEpoch),          // expiration_epoch: u64
            tx.pure.u64(5_000_000_000),            // trade_volume_limit: u64 (5 SUI)
            tx.pure.u64(1_000_000_000),            // max_trade_size: u64 (1 SUI)
            // ctx auto-injected
        ],
    });

    const result = await client.signAndExecuteTransaction({
        signer,
        transaction: tx,
        options: {
            showEffects: true,
            showObjectChanges: true,
            showEvents: true,
        },
    });

    console.log(`  TX Digest: ${result.digest}`);

    // ─── Find the created DelegatedTradingCap ───
    const capObj = result.objectChanges?.find(
        (change: { type: string; objectType?: string }) =>
            change.type === 'created' &&
            change.objectType?.includes('::capabilities::DelegatedTradingCap'),
    );

    if (capObj && capObj.type === 'created') {
        console.log(`  ✅ DelegatedTradingCap minted: ${capObj.objectId}`);
        console.log(`     Owner: ${AGENT_ADDRESS}`);

        // Show DelegationMinted event
        if (result.events && result.events.length > 0) {
            console.log('\n  📡 Events emitted:');
            for (const event of result.events) {
                console.log(`    - ${event.type}`);
                console.log(`      ${JSON.stringify(event.parsedJson, null, 2)}`);
            }
        }

        return capObj.objectId;
    }

    console.error('  ❌ Failed to find DelegatedTradingCap in results');
    return null;
}

// ═══════════════════════════════════════════════════════
// OPERATION 2: QUERY VAULT STATE
// ═══════════════════════════════════════════════════════

/**
 * Query and display the full vault state including dynamic fields.
 *
 * ─── DYNAMIC FIELD INSPECTION ───
 * The vault stores `Balance<T>` as Dynamic Fields keyed by `TypeName`.
 * To enumerate them, we use `getDynamicFields()` on the vault's object ID.
 * To read a specific balance, we use `getDynamicFieldObject()` with the key.
 *
 * This is analogous to Solana's pattern of listing all PDAs derived from
 * a program + seeds, except Dynamic Fields are explicitly linked to a parent
 * object rather than derived from seeds.
 */
async function queryVaultState(
    client: SuiJsonRpcClient,
    vaultId: string,
): Promise<void> {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('OPERATION 2: Querying vault state...');
    console.log('═══════════════════════════════════════════════════════');

    // ─── Read the vault object itself ───
    const vault = await client.getObject({
        id: vaultId,
        options: {
            showContent: true,
            showType: true,
            showOwner: true,
        },
    });

    if (vault.data?.content?.dataType === 'moveObject') {
        const fields = vault.data.content.fields as Record<string, unknown>;
        console.log('  Vault State:');
        console.log(`    Version: ${fields['version']}`);
        console.log(`    Max Slippage BPS: ${fields['max_slippage_bps']}`);
        console.log(`    Trading Enabled: ${fields['trading_enabled']}`);
        console.log(`    Owner: ${JSON.stringify(vault.data.owner)}`);
    }

    // ─── Enumerate dynamic fields (Balance<T> entries) ───
    const dynamicFields = await client.getDynamicFields({
        parentId: vaultId,
    });

    console.log(`\n  Asset Balances (${dynamicFields.data.length} types):`);
    for (const field of dynamicFields.data) {
        // Read the actual balance value
        const fieldObj = await client.getDynamicFieldObject({
            parentId: vaultId,
            name: field.name,
        });

        if (fieldObj.data?.content?.dataType === 'moveObject') {
            const balanceFields = fieldObj.data.content.fields as Record<string, unknown>;
            console.log(`    - ${JSON.stringify(field.name.value)}`);
            console.log(`      Balance: ${JSON.stringify(balanceFields)}`);
        }
    }
}

// ═══════════════════════════════════════════════════════
// OPERATION 3: REVOKE ALL DELEGATIONS
// ═══════════════════════════════════════════════════════

/**
 * Revoke all outstanding DelegatedTradingCaps in O(1).
 *
 * ─── MOVE FUNCTION BEING CALLED ───
 * ```move
 * public fun revoke_all_delegations(
 *     vault: &mut Vault,
 *     owner_cap: &OwnerCap,
 *     _ctx: &TxContext,
 * )
 * ```
 *
 * ─── THE O(1) REVOCATION TRICK ───
 * This simply increments `vault.version`. All existing DelegatedTradingCaps
 * have a `version` field that was snapshot at mint time. When `authenticate_trade`
 * runs, it checks: `cap.version == vault.version`. After a version bump, ALL
 * caps with the old version fail this check — instant universal revocation.
 *
 * ─── SOLANA COMPARISON ───
 * On Solana, revoking multiple delegates would require:
 *   a) Iterating over all delegate PDA accounts and closing them, OR
 *   b) Maintaining a "revocation bitmap" in the vault account, OR
 *   c) Using a merkle tree for efficient revocation checks
 *
 * All of these are O(n) or require complex data structures. The Sui approach
 * is O(1) because the "revocation state" is a single u64 counter, and each
 * cap carries its own validity proof (version snapshot). No enumeration needed.
 *
 * This pattern was highlighted at Sui Basecamp 2024 as a canonical example
 * of why object-centric design enables more efficient authorization models.
 */
async function revokeAllDelegations(
    client: SuiJsonRpcClient,
    signer: Ed25519Keypair,
    packageId: string,
    vaultId: string,
    ownerCapId: string,
): Promise<void> {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('OPERATION 3: Revoking ALL delegations...');
    console.log('═══════════════════════════════════════════════════════');

    const tx = new Transaction();

    // ─── moveCall: vault::revoke_all_delegations ───
    // This is a single instruction — no iteration over caps needed.
    // The vault's version counter increments by 1, and ALL existing
    // caps become instantly invalid.
    tx.moveCall({
        target: `${packageId}::vault::revoke_all_delegations`,
        arguments: [
            tx.object(vaultId),       // &mut Vault    — requires consensus (Shared Object write)
            tx.object(ownerCapId),    // &OwnerCap     — proves ownership
            // _ctx: &TxContext       — auto-injected (immutable ref, not &mut)
        ],
    });

    const result = await client.signAndExecuteTransaction({
        signer,
        transaction: tx,
        options: {
            showEffects: true,
            showEvents: true,
        },
    });

    console.log(`  TX Digest: ${result.digest}`);
    console.log('  ✅ All delegations revoked (vault version incremented)');

    if (result.events && result.events.length > 0) {
        console.log('\n  📡 Events emitted:');
        for (const event of result.events) {
            console.log(`    - ${event.type}`);
            console.log(`      ${JSON.stringify(event.parsedJson, null, 2)}`);
        }
    }
}

// ═══════════════════════════════════════════════════════
// OPERATION 4: TOGGLE TRADING
// ═══════════════════════════════════════════════════════

/**
 * Enable or disable trading on the vault (emergency kill switch).
 *
 * ─── MOVE FUNCTION BEING CALLED ───
 * ```move
 * public fun set_trading_enabled(
 *     vault: &mut Vault,
 *     owner_cap: &OwnerCap,
 *     enabled: bool,
 *     _ctx: &TxContext,
 * )
 * ```
 */
async function toggleTrading(
    client: SuiJsonRpcClient,
    signer: Ed25519Keypair,
    packageId: string,
    vaultId: string,
    ownerCapId: string,
    enabled: boolean,
): Promise<void> {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log(`OPERATION 4: Setting trading_enabled = ${enabled}...`);
    console.log('═══════════════════════════════════════════════════════');

    const tx = new Transaction();

    tx.moveCall({
        target: `${packageId}::vault::set_trading_enabled`,
        arguments: [
            tx.object(vaultId),          // &mut Vault
            tx.object(ownerCapId),       // &OwnerCap
            tx.pure.bool(enabled),       // enabled: bool
            // _ctx: &TxContext — auto-injected
        ],
    });

    const result = await client.signAndExecuteTransaction({
        signer,
        transaction: tx,
        options: {
            showEffects: true,
            showEvents: true,
        },
    });

    console.log(`  TX Digest: ${result.digest}`);
    console.log(`  ✅ Trading ${enabled ? 'enabled' : 'disabled'}`);

    if (result.events && result.events.length > 0) {
        console.log('\n  📡 Events emitted:');
        for (const event of result.events) {
            console.log(`    - ${event.type}`);
            console.log(`      ${JSON.stringify(event.parsedJson, null, 2)}`);
        }
    }
}

// ═══════════════════════════════════════════════════════
// OPERATION 5: DESTROY INERT CAP
// ═══════════════════════════════════════════════════════

/**
 * Destroy an inert (expired/exhausted/revoked) DelegatedTradingCap
 * to reclaim its storage rebate.
 *
 * ─── MOVE FUNCTION BEING CALLED ───
 * ```move
 * public fun destroy_inert_cap(
 *     vault: &Vault,
 *     cap: DelegatedTradingCap,    // Consumed by value — destroyed
 *     ctx: &TxContext,
 * )
 * ```
 *
 * ─── MOVE'S LINEAR TYPE SYSTEM ───
 * Notice `cap: DelegatedTradingCap` (no `&` prefix) — this means the function
 * CONSUMES the cap by value. After this call, the cap no longer exists anywhere.
 * The Move bytecode verifier ensures at compile time that consumed values cannot
 * be used after the function call.
 *
 * On Solana, "closing" an account sets its lamports to 0 and data length to 0,
 * returning the rent to the specified recipient. But nothing prevents you from
 * accidentally referencing the closed account in subsequent instructions (you'd
 * get a runtime error, not a compile-time error). Move catches this at compile time.
 *
 * ─── STORAGE REBATE ───
 * Sui charges storage fees when objects are created. When objects are deleted,
 * the storage fee is rebated to the transaction sender. This incentivizes
 * cleanup of stale objects, unlike Solana where rent is continuous and there's
 * no incentive to close accounts beyond recovering lamports.
 */
async function destroyInertCap(
    client: SuiJsonRpcClient,
    signer: Ed25519Keypair,
    packageId: string,
    vaultId: string,
    capId: string,
): Promise<void> {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('OPERATION 5: Destroying inert DelegatedTradingCap...');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  Cap ID: ${capId}`);

    const tx = new Transaction();

    // ─── moveCall: capabilities::destroy_inert_cap ───
    // The cap is passed BY VALUE (consumed). In the PTB, we still use
    // tx.object() — the runtime handles ownership transfer into the function.
    // The function destructures the cap and calls object::delete(id).
    tx.moveCall({
        target: `${packageId}::capabilities::destroy_inert_cap`,
        arguments: [
            tx.object(vaultId),    // &Vault
            tx.object(capId),      // DelegatedTradingCap (consumed)
            // ctx: &TxContext — auto-injected
        ],
    });

    const result = await client.signAndExecuteTransaction({
        signer,
        transaction: tx,
        options: {
            showEffects: true,
        },
    });

    console.log(`  TX Digest: ${result.digest}`);
    console.log('  ✅ Cap destroyed, storage rebate reclaimed');
}

// ═══════════════════════════════════════════════════════
// MAIN EXECUTION
// ═══════════════════════════════════════════════════════

async function main() {
    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║   Time-Locked Vault — Management Script              ║');
    console.log('╚═══════════════════════════════════════════════════════╝');

    const config = loadConfig();
    const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(NETWORK), network: NETWORK });
    const signer = Ed25519Keypair.fromSecretKey(config.privateKey);
    const address = signer.toSuiAddress();

    console.log(`  Network: ${NETWORK}`);
    console.log(`  Owner Address: ${address}`);
    console.log(`  Package: ${config.packageId}`);
    console.log(`  Vault: ${config.vaultId}`);
    console.log(`  OwnerCap: ${config.ownerCapId}`);
    console.log('');

    // ─── Run management operations in sequence ───

    // 1. Show current vault state
    await queryVaultState(client, config.vaultId);

    // 2. Mint a DelegatedTradingCap for the AI agent
    const capId = await mintDelegatedTradingCap(
        client,
        signer,
        config.packageId,
        config.vaultId,
        config.ownerCapId,
    );

    // 3. Query state again to see updated version hasn't changed
    //    (minting doesn't change vault version)
    await queryVaultState(client, config.vaultId);

    // 4. Revoke all delegations (version bump)
    await revokeAllDelegations(
        client,
        signer,
        config.packageId,
        config.vaultId,
        config.ownerCapId,
    );

    // 5. Query state to confirm version was incremented
    await queryVaultState(client, config.vaultId);

    // 6. Destroy the now-revoked cap (if it was minted to the same address)
    if (capId && AGENT_ADDRESS === address) {
        await destroyInertCap(
            client,
            signer,
            config.packageId,
            config.vaultId,
            capId,
        );
    } else if (capId) {
        console.log(`\n  ℹ️  Cap ${capId} was sent to ${AGENT_ADDRESS}`);
        console.log('     Only that address can destroy it (they own it).');
    }

    // 7. Toggle trading off and back on
    await toggleTrading(
        client, signer, config.packageId, config.vaultId, config.ownerCapId,
        false, // disable
    );
    await toggleTrading(
        client, signer, config.packageId, config.vaultId, config.ownerCapId,
        true, // re-enable
    );

    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║   MANAGEMENT COMPLETE                                ║');
    console.log('╚═══════════════════════════════════════════════════════╝');
}

main().catch((err) => {
    console.error('\n❌ Management script failed:', err);
    process.exit(1);
});
