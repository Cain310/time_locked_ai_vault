/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * deploy.ts — Publish the Time-Locked Vault package & bootstrap a vault
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This script demonstrates the full deployment lifecycle:
 *   1. Build the Move package (via `sui move build --dump-bytecode-as-base64`)
 *   2. Publish the package to Sui testnet via a Programmable Transaction Block (PTB)
 *   3. Create a vault by calling `vault::create_vault_and_share`
 *   4. Deposit test SUI into the vault
 *
 * Usage:
 *   export SUI_PRIVATE_KEY="suiprivkey1..."   # Bech32-encoded private key
 *   npx tsx deploy.ts
 *
 * ─── SOLANA COMPARISON ───
 * On Solana, you'd run `anchor deploy` which calls `solana program deploy` under
 * the hood, uploading BPF bytecode to a Program account. On Sui, publication is
 * just another transaction — the compiled Move bytecode is embedded directly in
 * the PTB. There's no separate "program account" — the package becomes an
 * immutable on-chain object with its own ID.
 *
 * ─── SDK V2 NOTE ───
 * As of `@mysten/sui` v2.x, the client has been restructured:
 *   - `SuiClient` / `getFullnodeUrl` → `SuiJsonRpcClient` / `getJsonRpcFullnodeUrl`
 *     from `@mysten/sui/jsonRpc`
 *   - `Transaction`, `Ed25519Keypair` remain at the same subpaths
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { execSync } from 'child_process';
import { resolve } from 'path';

// ═══════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════

/** Sui network to deploy to */
const NETWORK: 'testnet' | 'devnet' | 'mainnet' = 'testnet';

/** Path to the Move package root (parent of this scripts/ directory) */
const PACKAGE_PATH = resolve(import.meta.dirname ?? '.', '..');

/** Maximum slippage tolerance for the vault in basis points (100 = 1%) */
const MAX_SLIPPAGE_BPS = 100;

/** Amount of SUI to deposit into the vault (in MIST: 1 SUI = 1_000_000_000 MIST) */
const DEPOSIT_AMOUNT = 1_000_000_000n; // 1 SUI

// ═══════════════════════════════════════════════════════
// KEYPAIR LOADING
// ═══════════════════════════════════════════════════════

/**
 * Load the deployer's Ed25519 keypair from the SUI_PRIVATE_KEY environment variable.
 *
 * ─── SOLANA COMPARISON ───
 * On Solana, you'd load from ~/.config/solana/id.json (a JSON array of 64 bytes).
 * On Sui, private keys are Bech32-encoded strings prefixed with "suiprivkey1".
 * The Ed25519Keypair.fromSecretKey() handles both raw bytes and Bech32 strings.
 */
function loadKeypair(): Ed25519Keypair {
    const privateKey = process.env.SUI_PRIVATE_KEY;
    if (!privateKey) {
        console.error('ERROR: Set SUI_PRIVATE_KEY environment variable');
        console.error('  export SUI_PRIVATE_KEY="suiprivkey1..."');
        console.error('  # Get one from: sui keytool generate ed25519');
        process.exit(1);
    }
    return Ed25519Keypair.fromSecretKey(privateKey);
}

// ═══════════════════════════════════════════════════════
// STEP 1: BUILD & PUBLISH
// ═══════════════════════════════════════════════════════

/**
 * Build the Move package and publish it to the network.
 *
 * ─── HOW THIS WORKS ───
 * `sui move build --dump-bytecode-as-base64` compiles the Move source and outputs
 * a JSON object with two arrays:
 *   - `modules`: base64-encoded compiled bytecode for each module
 *   - `dependencies`: package IDs that our package depends on (Sui framework, DeepBook, etc.)
 *
 * We feed these directly into `tx.publish()`, which creates a Publish command in the PTB.
 * The publish returns an UpgradeCap — a capability object that authorizes future upgrades
 * to this package. We transfer it to the deployer's address for safekeeping.
 *
 * ─── SOLANA COMPARISON ───
 * Solana's `solana program deploy` uploads BPF ELF bytecode into a buffer account,
 * then finalizes it into a Program account. The ProgramData account holds the upgrade
 * authority. On Sui, the UpgradeCap IS the upgrade authority — it's a transferable
 * object, not an account field. You can lock it, wrap it in a timelock, or burn it
 * to make the package immutable.
 */
async function publishPackage(
    client: SuiJsonRpcClient,
    signer: Ed25519Keypair,
): Promise<{ packageId: string; upgradeCap: string }> {
    console.log('═══════════════════════════════════════════════════════');
    console.log('STEP 1: Building and publishing Move package...');
    console.log('═══════════════════════════════════════════════════════');

    // Build the package — this invokes the Move compiler
    const buildOutput = execSync(
        `sui move build --dump-bytecode-as-base64 --path ${PACKAGE_PATH}`,
        { encoding: 'utf-8' },
    );
    const { modules, dependencies } = JSON.parse(buildOutput);

    console.log(`  Compiled ${(modules as string[]).length} modules`);
    console.log(`  Dependencies: ${(dependencies as string[]).length} packages`);

    // ─── Construct the Publish PTB ───
    const tx = new Transaction();

    // tx.publish() creates a Publish command that returns an UpgradeCap
    // This is analogous to Solana's deploy + initialize in a single atomic TX
    const [upgradeCap] = tx.publish({ modules, dependencies });

    // Transfer the UpgradeCap to the deployer
    // On Solana, the upgrade authority is set on the ProgramData account.
    // On Sui, it's a first-class object you hold in your wallet.
    tx.transferObjects([upgradeCap], signer.toSuiAddress());

    // Execute the publish transaction
    const result = await client.signAndExecuteTransaction({
        signer,
        transaction: tx,
        options: {
            showEffects: true,
            showObjectChanges: true,
        },
    });

    console.log(`  TX Digest: ${result.digest}`);

    // ─── Parse the results ───
    // Find the published package ID from object changes
    const publishedPackage = result.objectChanges?.find(
        (change: { type: string }) => change.type === 'published',
    );
    if (!publishedPackage || publishedPackage.type !== 'published') {
        throw new Error('Failed to find published package in transaction results');
    }
    const packageId = publishedPackage.packageId;

    // Find the UpgradeCap object
    const upgradeCapObj = result.objectChanges?.find(
        (change: { type: string; objectType?: string }) =>
            change.type === 'created' &&
            change.objectType?.includes('::package::UpgradeCap'),
    );
    if (!upgradeCapObj || upgradeCapObj.type !== 'created') {
        throw new Error('Failed to find UpgradeCap in transaction results');
    }

    console.log(`  ✅ Package published: ${packageId}`);
    console.log(`  ✅ UpgradeCap: ${upgradeCapObj.objectId}`);

    return { packageId, upgradeCap: upgradeCapObj.objectId };
}

// ═══════════════════════════════════════════════════════
// STEP 2: CREATE VAULT
// ═══════════════════════════════════════════════════════

/**
 * Create a new vault and share it on the network.
 *
 * ─── MOVE FUNCTION BEING CALLED ───
 * ```move
 * public fun create_vault_and_share(
 *     max_slippage_bps: u64,
 *     ctx: &mut TxContext,
 * )
 * ```
 *
 * This function:
 *   1. Creates a Vault struct (key-only, no store)
 *   2. Creates an OwnerCap linked to the vault
 *   3. Shares the Vault (makes it a Shared Object)
 *   4. Transfers the OwnerCap to tx sender
 *
 * ─── SOLANA COMPARISON ───
 * On Solana, you'd call `initialize` on a program, which creates a PDA for
 * the vault state and stores the owner's pubkey in the account data.
 * On Sui, the vault becomes a Shared Object (accessible by anyone who knows
 * its ID via Mysticeti consensus), while the OwnerCap is an Owned Object
 * (fast-path, ~400ms finality) that proves authority.
 *
 * ─── PTB NOTE: ctx is auto-injected ───
 * Notice we do NOT pass `ctx: &mut TxContext` in the PTB arguments.
 * The Sui runtime automatically injects it for any function that declares it
 * as the last parameter. This is unlike Solana where you must explicitly pass
 * all accounts in the instruction's account list.
 */
async function createVault(
    client: SuiJsonRpcClient,
    signer: Ed25519Keypair,
    packageId: string,
): Promise<{ vaultId: string; ownerCapId: string }> {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('STEP 2: Creating vault...');
    console.log('═══════════════════════════════════════════════════════');

    const tx = new Transaction();

    // ─── moveCall: vault::create_vault_and_share ───
    // Arguments map to the Move function params (excluding ctx):
    //   max_slippage_bps: u64 → tx.pure.u64(100)
    //
    // On Solana, you'd build an Instruction with:
    //   program_id, accounts: [vault_pda, owner, system_program], data: borsh(100)
    // On Sui, there are NO accounts to list — the function creates new objects internally.
    tx.moveCall({
        target: `${packageId}::vault::create_vault_and_share`,
        arguments: [tx.pure.u64(MAX_SLIPPAGE_BPS)],
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

    // ─── Parse created objects ───
    // The vault is a Shared Object (mutated via consensus)
    // The OwnerCap is an Owned Object (fast-path transactions)
    const vaultObj = result.objectChanges?.find(
        (change: { type: string; objectType?: string }) =>
            change.type === 'created' &&
            change.objectType?.includes('::vault::Vault'),
    );
    const ownerCapObj = result.objectChanges?.find(
        (change: { type: string; objectType?: string }) =>
            change.type === 'created' &&
            change.objectType?.includes('::vault::OwnerCap'),
    );

    if (!vaultObj || vaultObj.type !== 'created') {
        throw new Error('Failed to find Vault in transaction results');
    }
    if (!ownerCapObj || ownerCapObj.type !== 'created') {
        throw new Error('Failed to find OwnerCap in transaction results');
    }

    console.log(`  ✅ Vault (Shared Object): ${vaultObj.objectId}`);
    console.log(`  ✅ OwnerCap (Owned Object): ${ownerCapObj.objectId}`);

    // ─── Display events ───
    if (result.events && result.events.length > 0) {
        console.log('\n  📡 Events emitted:');
        for (const event of result.events) {
            console.log(`    - ${event.type}`);
            console.log(`      ${JSON.stringify(event.parsedJson, null, 2)}`);
        }
    }

    return { vaultId: vaultObj.objectId, ownerCapId: ownerCapObj.objectId };
}

// ═══════════════════════════════════════════════════════
// STEP 3: DEPOSIT SUI INTO THE VAULT
// ═══════════════════════════════════════════════════════

/**
 * Deposit SUI into the vault using the OwnerCap.
 *
 * ─── MOVE FUNCTION BEING CALLED ───
 * ```move
 * public fun deposit<T>(
 *     vault: &mut Vault,
 *     owner_cap: &OwnerCap,
 *     coin: Coin<T>,
 *     _ctx: &mut TxContext,
 * )
 * ```
 *
 * ─── PTB RESULT PIPING ───
 * This demonstrates a critical Sui pattern: PTB command chaining.
 * We first split a coin from the gas object, then pipe that result
 * into the deposit call. This is TWO commands in a single atomic TX.
 *
 * On Solana, you'd need to pre-compute the exact account layout:
 *   - Source token account (ATA)
 *   - Vault's token account (PDA)
 *   - Token program
 *   - Associated token program
 * On Sui, you just split a coin and pass it in — no token accounts needed.
 * The `Balance<T>` abstraction handles everything inside the vault.
 *
 * ─── tx.splitCoins(tx.gas, [...]) ───
 * `tx.gas` is a special reference to the transaction's gas coin.
 * SUI is the native gas token, so splitting from gas gives us a Coin<SUI>.
 * This is analogous to Solana's wrapping SOL into wSOL, except it's atomic
 * and doesn't require a separate wrapper token.
 */
async function depositSui(
    client: SuiJsonRpcClient,
    signer: Ed25519Keypair,
    packageId: string,
    vaultId: string,
    ownerCapId: string,
): Promise<void> {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log(`STEP 3: Depositing ${Number(DEPOSIT_AMOUNT) / 1e9} SUI into vault...`);
    console.log('═══════════════════════════════════════════════════════');

    const tx = new Transaction();

    // ─── Command 1: Split a coin from the gas object ───
    // This creates a new Coin<SUI> with the specified amount.
    // tx.gas is a special PTB input that references the gas coin.
    // The result `[depositCoin]` can be piped into subsequent commands.
    const [depositCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(DEPOSIT_AMOUNT)]);

    // ─── Command 2: Call vault::deposit<SUI> ───
    // Notice how we pass `depositCoin` (a TransactionResult from Command 1)
    // directly as an argument. This is PTB result piping — the output of one
    // command becomes the input of the next, all within a single atomic TX.
    //
    // Type arguments: We must specify the generic `T` = SUI's type tag.
    // `0x2::sui::SUI` is the fully qualified type for the SUI native token.
    tx.moveCall({
        target: `${packageId}::vault::deposit`,
        typeArguments: ['0x2::sui::SUI'],
        arguments: [
            tx.object(vaultId),       // &mut Vault     — Shared Object (consensus path)
            tx.object(ownerCapId),    // &OwnerCap      — Owned Object  (fast path)
            depositCoin,              // Coin<SUI>       — Result from splitCoins above
            // ctx: &mut TxContext    — auto-injected by runtime
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
    console.log(`  ✅ Deposited ${Number(DEPOSIT_AMOUNT) / 1e9} SUI`);

    // Display BalanceChanged events
    if (result.events && result.events.length > 0) {
        console.log('\n  📡 Events emitted:');
        for (const event of result.events) {
            console.log(`    - ${event.type}`);
            console.log(`      ${JSON.stringify(event.parsedJson, null, 2)}`);
        }
    }
}

// ═══════════════════════════════════════════════════════
// STEP 4: VERIFY VAULT STATE
// ═══════════════════════════════════════════════════════

/**
 * Read the vault's on-chain state to verify deployment succeeded.
 *
 * ─── SOLANA COMPARISON ───
 * On Solana, you'd call `connection.getAccountInfo(vaultPDA)` and deserialize
 * the account data using Borsh or Anchor's `Program.account.vault.fetch()`.
 *
 * On Sui, `client.getObject()` returns the entire object including its
 * Move struct fields in `content.fields`. The runtime automatically
 * serializes Move structs to JSON — no custom deserialization needed.
 *
 * Note: Dynamic Fields (like our Balance<T> entries) are NOT included in
 * getObject. You'd need `client.getDynamicFields()` to enumerate them.
 * This is architecturally similar to Solana PDAs — they're separate
 * "accounts" (objects) linked by a parent-child relationship.
 */
async function verifyVaultState(
    client: SuiJsonRpcClient,
    vaultId: string,
    packageId: string,
): Promise<void> {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('STEP 4: Verifying vault state...');
    console.log('═══════════════════════════════════════════════════════');

    // ─── Read vault object ───
    const vault = await client.getObject({
        id: vaultId,
        options: {
            showContent: true,
            showType: true,
            showOwner: true,
        },
    });

    console.log(`  Type: ${vault.data?.type}`);
    console.log(`  Owner: ${JSON.stringify(vault.data?.owner)}`);

    if (vault.data?.content?.dataType === 'moveObject') {
        const fields = vault.data.content.fields as Record<string, unknown>;
        console.log(`  Version: ${fields['version']}`);
        console.log(`  Max Slippage BPS: ${fields['max_slippage_bps']}`);
        console.log(`  Trading Enabled: ${fields['trading_enabled']}`);
    }

    // ─── List dynamic fields (Balance<T> entries) ───
    const dynamicFields = await client.getDynamicFields({
        parentId: vaultId,
    });

    console.log(`\n  Dynamic Fields (${dynamicFields.data.length} asset types):`);
    for (const field of dynamicFields.data) {
        console.log(`    - Key: ${JSON.stringify(field.name)}`);
        console.log(`      Object ID: ${field.objectId}`);
    }

    // ─── Query VaultCreated events ───
    const events = await client.queryEvents({
        query: {
            MoveEventType: `${packageId}::events::VaultCreated`,
        },
        limit: 5,
    });

    console.log(`\n  📡 VaultCreated events found: ${events.data.length}`);
    for (const event of events.data) {
        console.log(`    ${JSON.stringify(event.parsedJson, null, 2)}`);
    }
}

// ═══════════════════════════════════════════════════════
// MAIN EXECUTION
// ═══════════════════════════════════════════════════════

async function main() {
    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║   Time-Locked Vault — Deploy & Bootstrap Script      ║');
    console.log('╚═══════════════════════════════════════════════════════╝');
    console.log(`  Network: ${NETWORK}`);
    console.log(`  Package Path: ${PACKAGE_PATH}`);
    console.log('');

    // ─── Setup client and signer ───
    const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(NETWORK), network: NETWORK });
    const signer = loadKeypair();
    const address = signer.toSuiAddress();
    console.log(`  Deployer Address: ${address}`);

    // Verify the deployer has gas
    const balance = await client.getBalance({ owner: address });
    console.log(`  SUI Balance: ${Number(balance.totalBalance) / 1e9} SUI`);

    if (BigInt(balance.totalBalance) < 500_000_000n) {
        console.error('\n  ⚠️  Low balance! Request testnet SUI from the faucet:');
        console.error('     https://faucet.sui.io/');
        process.exit(1);
    }

    // ─── Execute deployment pipeline ───
    const { packageId } = await publishPackage(client, signer);
    const { vaultId, ownerCapId } = await createVault(client, signer, packageId);
    await depositSui(client, signer, packageId, vaultId, ownerCapId);
    await verifyVaultState(client, vaultId, packageId);

    // ─── Output summary ───
    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║   DEPLOYMENT COMPLETE — Save these IDs!              ║');
    console.log('╚═══════════════════════════════════════════════════════╝');
    console.log(`  PACKAGE_ID="${packageId}"`);
    console.log(`  VAULT_ID="${vaultId}"`);
    console.log(`  OWNER_CAP_ID="${ownerCapId}"`);
    console.log('');
    console.log('  Export these for the next scripts:');
    console.log(`    export PACKAGE_ID="${packageId}"`);
    console.log(`    export VAULT_ID="${vaultId}"`);
    console.log(`    export OWNER_CAP_ID="${ownerCapId}"`);
}

main().catch((err) => {
    console.error('\n❌ Deployment failed:', err);
    process.exit(1);
});
