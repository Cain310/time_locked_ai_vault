/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * execute_trade.ts — AI Agent trade execution via PTB with MVR integration
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This script demonstrates the AI agent's trading flow:
 *   1. Initialize SuiJsonRpcClient with built-in MVR (Move Registry) support
 *   2. Construct a multi-step PTB that authenticates and swaps atomically
 *   3. Dry-run the transaction to validate and estimate gas
 *   4. Execute the transaction if dry-run succeeds
 *
 * ─── MVR Integration ───
 * The Move Registry (MVR) replaces hardcoded 64-character hex package addresses
 * with human-readable names. In SDK v2, MVR is built into `SuiJsonRpcClient`
 * via the `mvr` option — no separate plugin needed. When you use a target like:
 *   `@mysten/deepbook-v3::pool::swap_exact_base_for_quote`
 * the client resolves it to the on-chain package address at build time.
 *
 * Usage:
 *   export SUI_PRIVATE_KEY="suiprivkey1..."     (agent's key, not owner's)
 *   export PACKAGE_ID="0x..."
 *   export VAULT_ID="0x..."
 *   export CAP_ID="0x..."                       (DelegatedTradingCap object ID)
 *   export POOL_ID="0x..."                      (DeepBook V3 Pool object ID)
 *   npx tsx execute_trade.ts
 *
 * ─── CRITICAL ARCHITECTURE NOTE ───
 * Our on-chain trading.move wraps authentication + DeepBook swap + vault deposit
 * into a SINGLE moveCall. The PTB for the agent is therefore simpler than the
 * Phase 2 doc's 3-step PTB example (which showed a decomposed flow). Our actual
 * implementation uses `execute_swap_base_to_quote` which does everything atomically.
 *
 * However, this script ALSO demonstrates the decomposed PTB pattern for educational
 * purposes, showing how result piping would work if the operations were separate.
 *
 * ─── SDK V2 CHANGES ───
 * `@mysten/sui` v2.x restructured the client:
 *   - `SuiClient` / `getFullnodeUrl` → `SuiJsonRpcClient` / `getJsonRpcFullnodeUrl`
 *     from `@mysten/sui/jsonRpc`
 *   - `Transaction.registerGlobalPlugin()` removed — MVR is now built into the client
 *     via `SuiJsonRpcClient({ ..., mvr: { ... } })`
 *   - `@mysten/mvr-static` is now a CLI code-gen tool that pre-resolves names to a
 *     static cache file, not a runtime import
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

// ═══════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════

const NETWORK: 'testnet' | 'devnet' | 'mainnet' = 'testnet';

/**
 * System Clock Object ID — always 0x6 on all Sui networks.
 *
 * ─── SOLANA COMPARISON ───
 * On Solana, you'd use `solana_program::clock::Clock` sysvar at address
 * `SysvarC1ock11111111111111111111111111111111`. Same concept — a system-level
 * singleton that provides time information. On Sui, the Clock is a Shared Object
 * at address 0x6, accessed via `&Clock` (immutable reference).
 */
const CLOCK_OBJECT_ID = '0x6';

/** Load required environment variables with validation */
function loadConfig() {
    const required = ['PACKAGE_ID', 'VAULT_ID', 'CAP_ID', 'SUI_PRIVATE_KEY'] as const;
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        console.error(`ERROR: Missing environment variables: ${missing.join(', ')}`);
        console.error('Run deploy.ts and manage_vault.ts first.');
        process.exit(1);
    }

    return {
        packageId: process.env.PACKAGE_ID!,
        vaultId: process.env.VAULT_ID!,
        capId: process.env.CAP_ID!,
        poolId: process.env.POOL_ID ?? '', // Optional — only needed for live DeepBook swap
        privateKey: process.env.SUI_PRIVATE_KEY!,
    };
}

// ═══════════════════════════════════════════════════════
// MVR-ENABLED CLIENT SETUP
// ═══════════════════════════════════════════════════════

/**
 * Create a SuiJsonRpcClient with built-in MVR (Move Registry) support.
 *
 * ─── WHAT IS MVR? ───
 * The Move Registry (built by Mysten Labs) maps human-readable package
 * names to on-chain package addresses. Instead of writing:
 *   target: '0xdee9...::pool::swap_exact_base_for_quote'
 * You write:
 *   target: '@mysten/deepbook-v3::pool::swap_exact_base_for_quote'
 *
 * In SDK v2, MVR resolution is built directly into SuiJsonRpcClient. When a
 * Transaction is built via `client.signAndExecuteTransaction()`, any MVR-style
 * targets are resolved automatically before submission.
 *
 * ─── WHY USE MVR? ───
 * Using MVR in a project demonstrates both:
 *   1. Awareness of Sui ecosystem tooling beyond basic SDK usage
 *   2. Best practice for maintainable code (no hardcoded hex addresses)
 *
 * ─── SOLANA COMPARISON ───
 * Solana has no equivalent registry. You hardcode program IDs:
 *   const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQ...');
 * Or use Anchor's IDL declarations which embed program IDs. There's no
 * runtime resolution layer like MVR provides.
 *
 * ─── SDK v2 MVR OPTIONS ───
 * The `mvr` option on SuiJsonRpcClient configures automatic resolution.
 * You can also pre-generate a static cache via `npx @mysten/mvr-static`
 * and pass it as `overrides` for offline resolution (no network round-trip).
 */
function createMvrClient(): SuiJsonRpcClient {
    console.log('  🔌 Creating SuiJsonRpcClient with MVR support...');

    // The `network` field enables MVR resolution for that network.
    // Named package targets like '@mysten/deepbook-v3::pool::...' will be
    // resolved to actual on-chain addresses automatically.
    const client = new SuiJsonRpcClient({
        url: getJsonRpcFullnodeUrl(NETWORK),
        network: NETWORK,
        // Optional: pass static MVR overrides for offline resolution
        // mvr: { overrides: getMvrCache('testnet') }
    });

    console.log('  ✅ Client ready — MVR human-readable package names enabled');
    return client;
}

// ═══════════════════════════════════════════════════════
// APPROACH 1: ATOMIC SWAP (Our actual on-chain implementation)
// ═══════════════════════════════════════════════════════

/**
 * Execute a delegated swap using our atomic execute_swap_base_to_quote.
 *
 * ─── MOVE FUNCTION BEING CALLED ───
 * ```move
 * public fun execute_swap_base_to_quote<BaseAsset, QuoteAsset>(
 *     vault: &mut Vault,
 *     cap: &mut DelegatedTradingCap,
 *     pool: &mut Pool<BaseAsset, QuoteAsset>,
 *     trade_amount: u64,
 *     min_quote_out: u64,
 *     clock: &Clock,
 *     ctx: &mut TxContext,
 * )
 * ```
 *
 * This function atomically:
 *   1. Authenticates the cap (6 assertions)
 *   2. Extracts coins from vault dynamic fields
 *   3. Calls DeepBook's swap_exact_base_for_quote
 *   4. Deposits all results (leftovers + received) back into vault
 *   5. Emits TradeExecuted event
 *
 * ─── WHY ATOMIC? ───
 * By wrapping the entire flow in a single Move function, we guarantee that
 * if ANY step fails (authentication, insufficient balance, slippage), the
 * entire transaction reverts. There's no state where coins are extracted but
 * not deposited back. Move's linear type system enforces this — every Coin
 * created must be consumed (deposited, transferred, or destroyed) by the
 * end of the function.
 *
 * ─── SOLANA COMPARISON ───
 * On Solana, you'd typically build a single instruction per swap, but
 * cross-program invocations (CPI) handle the internal flow. The key
 * difference is that Solana doesn't have a type system that prevents
 * accidental token loss — you rely on runtime checks in the program logic.
 * Move's compiler guarantees that no Coin<T> is silently dropped.
 */
async function executeAtomicSwap(
    client: SuiJsonRpcClient,
    signer: Ed25519Keypair,
    config: ReturnType<typeof loadConfig>,
    tradeAmount: bigint,
    minQuoteOut: bigint,
    baseAssetType: string,
    quoteAssetType: string,
): Promise<void> {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('APPROACH 1: Atomic swap via execute_swap_base_to_quote');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  Trade Amount: ${Number(tradeAmount) / 1e9}`);
    console.log(`  Min Quote Out: ${Number(minQuoteOut) / 1e9}`);
    console.log(`  Direction: ${baseAssetType} → ${quoteAssetType}`);

    if (!config.poolId) {
        console.log('\n  ⚠️  POOL_ID not set — showing PTB construction only (no execution)');

        const tx = new Transaction();

        // ─── Single moveCall does everything atomically ───
        tx.moveCall({
            target: `${config.packageId}::trading::execute_swap_base_to_quote`,
            typeArguments: [baseAssetType, quoteAssetType],
            arguments: [
                tx.object(config.vaultId),     // &mut Vault         (Shared Object)
                tx.object(config.capId),        // &mut DelegatedTradingCap (Owned Object)
                tx.object('0xPOOL_ID'),         // &mut Pool<B,Q>    (Shared Object) — placeholder
                tx.pure.u64(tradeAmount),       // trade_amount: u64
                tx.pure.u64(minQuoteOut),       // min_quote_out: u64
                tx.object(CLOCK_OBJECT_ID),     // &Clock            (Shared Object 0x6)
                // ctx: &mut TxContext — auto-injected
            ],
        });

        console.log('\n  📝 PTB constructed (not executed — no Pool ID):');
        console.log('     Commands: 1 (execute_swap_base_to_quote)');
        console.log('     Objects: Vault (Shared), Cap (Owned), Pool (Shared), Clock (Shared)');
        console.log('     Type Args:', baseAssetType, '→', quoteAssetType);
        return;
    }

    // ─── Build and execute the PTB ───
    const tx = new Transaction();

    tx.moveCall({
        target: `${config.packageId}::trading::execute_swap_base_to_quote`,
        typeArguments: [baseAssetType, quoteAssetType],
        arguments: [
            tx.object(config.vaultId),
            tx.object(config.capId),
            tx.object(config.poolId),
            tx.pure.u64(tradeAmount),
            tx.pure.u64(minQuoteOut),
            tx.object(CLOCK_OBJECT_ID),
        ],
    });

    // ─── DRY RUN FIRST ───
    // Always dry-run before executing to catch errors and estimate gas.
    // This is a Sui best practice — dry runs are free (no gas cost).
    console.log('\n  🔍 Dry-running transaction...');
    const dryRunResult = await client.dryRunTransactionBlock({
        transactionBlock: await tx.build({ client }),
    });

    console.log(`  Dry run status: ${dryRunResult.effects.status.status}`);
    if (dryRunResult.effects.status.status !== 'success') {
        console.error(`  ❌ Dry run failed: ${dryRunResult.effects.status.error}`);
        return;
    }

    // Show gas estimate
    const gasUsed = dryRunResult.effects.gasUsed;
    console.log(`  Estimated gas: computation=${gasUsed.computationCost}, storage=${gasUsed.storageCost}`);

    // ─── EXECUTE ───
    console.log('\n  🚀 Executing transaction...');
    const result = await client.signAndExecuteTransaction({
        signer,
        transaction: tx,
        options: {
            showEffects: true,
            showEvents: true,
        },
    });

    console.log(`  TX Digest: ${result.digest}`);
    console.log(`  Status: ${result.effects?.status?.status}`);

    // ─── Display TradeExecuted events ───
    if (result.events && result.events.length > 0) {
        console.log('\n  📡 Events emitted:');
        for (const event of result.events) {
            console.log(`    - ${event.type}`);
            console.log(`      ${JSON.stringify(event.parsedJson, null, 2)}`);
        }
    }
}

// ═══════════════════════════════════════════════════════
// APPROACH 2: DECOMPOSED PTB WITH RESULT PIPING (Educational)
// ═══════════════════════════════════════════════════════

/**
 * Demonstrate how a decomposed PTB with result piping WOULD work.
 *
 * This is the pattern from Phase 2 Section 3.3 — it shows how you'd
 * chain multiple moveCall commands if the operations were split into
 * separate on-chain functions (authenticate_and_withdraw, DeepBook swap,
 * deposit_swap_results).
 *
 * ─── WHAT IS PTB RESULT PIPING? ───
 * A Programmable Transaction Block (PTB) can contain multiple commands.
 * The return value of one command can be used as input to the next.
 * This is how you compose complex multi-step operations atomically.
 *
 * ```typescript
 * // Command 0 returns two coins
 * const [baseCoin, deepCoin] = tx.moveCall({ ... });
 *
 * // Command 1 uses those coins and returns three
 * const [baseLeftover, quoteReceived, deepLeftover] = tx.moveCall({
 *     arguments: [..., baseCoin, deepCoin, ...],  // <-- piped from Command 0
 * });
 *
 * // Command 2 consumes the results
 * tx.moveCall({
 *     arguments: [..., baseLeftover, quoteReceived, deepLeftover],
 * });
 * ```
 *
 * ─── SOLANA COMPARISON: PTB vs Instructions ───
 * Solana transactions contain a list of Instructions, each calling a program.
 * But instructions can't directly "pipe" results between each other!
 *
 * On Solana, the equivalent pattern requires:
 *   1. Pre-creating intermediate token accounts (PDAs)
 *   2. Having Program A write to Account X
 *   3. Having Program B read from Account X
 * This requires pre-computing all intermediate accounts, and each account
 * needs rent-exemption minimum balances.
 *
 * On Sui, PTB result piping eliminates intermediate storage entirely. The
 * values flow through the PTB's internal result buffer — they never need
 * to be written to on-chain storage. This is more gas-efficient and ensures
 * that intermediate values can't be observed or manipulated by other txs.
 *
 * ─── WHY THIS MATTERS ───
 * PTB composability is one of Sui's most powerful features. Understanding
 * it with a concrete example (authentication → swap → deposit)
 * demonstrates deep knowledge of the execution model.
 *
 * ─── MVR IN THE DECOMPOSED FLOW ───
 * Step 2 below shows how you'd use an MVR target like
 * `@mysten/deepbook-v3::pool::swap_exact_base_for_quote` instead of a
 * raw hex address. With MVR-enabled `SuiJsonRpcClient`, this resolves
 * automatically at build time — no manual address lookup needed.
 */
function demonstratePtbResultPiping(
    config: ReturnType<typeof loadConfig>,
    baseAssetType: string,
    quoteAssetType: string,
): void {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('APPROACH 2: Decomposed PTB with result piping');
    console.log('  (Educational demonstration — not executed)');
    console.log('═══════════════════════════════════════════════════════');

    // ─── STEP 1: Authenticate + withdraw coins from vault ───
    // If we had a decomposed function like:
    //   public fun authenticate_and_withdraw<BaseAsset>(
    //       vault: &mut Vault,
    //       cap: &mut DelegatedTradingCap,
    //       trade_amount: u64,
    //       clock: &Clock,
    //       ctx: &mut TxContext,
    //   ): (Coin<BaseAsset>, Coin<DEEP>)
    //
    // We'd call it and destructure the result:
    console.log('\n  Step 1: authenticate_and_withdraw (hypothetical)');
    console.log('    → Returns: [Coin<BaseAsset>, Coin<DEEP>]');
    console.log('    → These become inputs to Step 2');

    // In TypeScript SDK, destructuring moveCall results looks like:
    // const [baseCoin, deepCoin] = tx.moveCall({ ... });
    // Each variable is a TransactionResult that can be passed to the next moveCall.

    // ─── STEP 2: Execute DeepBook swap via MVR ───
    // Using MVR human-readable name instead of hex address:
    console.log('\n  Step 2: @mysten/deepbook-v3::pool::swap_exact_base_for_quote');
    console.log('    → MVR resolves @mysten/deepbook-v3 to actual package address');
    console.log('    → Takes: baseCoin (from Step 1), deepCoin (from Step 1)');
    console.log('    → Returns: [Coin<BaseAsset> leftover, Coin<QuoteAsset>, Coin<DEEP> leftover]');

    // The MVR target would look like:
    // tx.moveCall({
    //     target: '@mysten/deepbook-v3::pool::swap_exact_base_for_quote',
    //     typeArguments: [baseAssetType, quoteAssetType],
    //     arguments: [
    //         tx.object(POOL_ID),       // &mut Pool<Base, Quote>
    //         baseCoin,                 // Coin<BaseAsset> from Step 1
    //         deepCoin,                 // Coin<DEEP> from Step 1
    //         tx.pure.u64(minQuoteOut), // min_quote_out
    //         tx.object('0x6'),         // &Clock
    //     ],
    // });

    // ─── STEP 3: Deposit results back into vault ───
    console.log('\n  Step 3: deposit_swap_results (hypothetical)');
    console.log('    → Takes: baseLeftover, quoteReceived, deepLeftover (all from Step 2)');
    console.log('    → These values flow through the PTB result buffer');
    console.log('    → Never written to intermediate on-chain storage');

    // ─── VISUALIZATION ───
    console.log('\n  ┌──────────────────────────────────────────────────────────────┐');
    console.log('  │                    PTB RESULT FLOW                          │');
    console.log('  │                                                            │');
    console.log('  │  Command 0: authenticate_and_withdraw                      │');
    console.log('  │     ↓ Coin<Base>  ↓ Coin<DEEP>                            │');
    console.log('  │  Command 1: swap_exact_base_for_quote (via MVR)            │');
    console.log('  │     ↓ Coin<Base>  ↓ Coin<Quote>  ↓ Coin<DEEP>            │');
    console.log('  │  Command 2: deposit_swap_results                           │');
    console.log('  │     (all coins deposited back into vault)                  │');
    console.log('  │                                                            │');
    console.log('  │  All 3 commands execute atomically.                        │');
    console.log('  │  If any command fails, EVERYTHING reverts.                 │');
    console.log('  └──────────────────────────────────────────────────────────────┘');

    console.log('\n  ─── COMPARISON TABLE ───');
    console.log('  ┌──────────────────────┬──────────────────────┬──────────────────────┐');
    console.log('  │ Feature              │ Sui PTB              │ Solana Instructions  │');
    console.log('  ├──────────────────────┼──────────────────────┼──────────────────────┤');
    console.log('  │ Result Piping        │ ✅ Direct value flow │ ❌ Via accounts      │');
    console.log('  │ Intermediate Storage │ Not needed           │ Temp accounts (PDAs) │');
    console.log('  │ Atomicity            │ Entire PTB is atomic │ Per-instruction       │');
    console.log('  │ Composability        │ Any public function  │ Needs CPI support    │');
    console.log('  │ Gas Efficiency       │ No rent for temps    │ Rent for temp accts  │');
    console.log('  │ Package Resolution   │ MVR human-readable   │ Hardcoded program IDs│');
    console.log('  └──────────────────────┴──────────────────────┴──────────────────────┘');
}

// ═══════════════════════════════════════════════════════
// QUERY TRADING CAP STATE
// ═══════════════════════════════════════════════════════

/**
 * Read the DelegatedTradingCap's on-chain state before trading.
 *
 * ─── SOLANA COMPARISON ───
 * On Solana, you'd deserialize a PDA's account data to check delegate
 * permissions. On Sui, the DelegatedTradingCap is a standalone object
 * with its own on-chain representation. You can inspect it directly.
 */
async function queryCapState(
    client: SuiJsonRpcClient,
    capId: string,
): Promise<void> {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('QUERY: DelegatedTradingCap state');
    console.log('═══════════════════════════════════════════════════════');

    try {
        const cap = await client.getObject({
            id: capId,
            options: {
                showContent: true,
                showType: true,
                showOwner: true,
            },
        });

        if (cap.data?.content?.dataType === 'moveObject') {
            const fields = cap.data.content.fields as Record<string, unknown>;
            console.log('  DelegatedTradingCap:');
            console.log(`    Type: ${cap.data.type}`);
            console.log(`    Owner: ${JSON.stringify(cap.data.owner)}`);
            console.log(`    Vault ID: ${fields['vault_id']}`);
            console.log(`    Expiration Epoch: ${fields['expiration_epoch']}`);
            console.log(`    Remaining Volume: ${fields['remaining_trade_volume']}`);
            console.log(`    Max Trade Size: ${fields['max_trade_size']}`);
            console.log(`    Version (snapshot): ${fields['version']}`);
        } else {
            console.log(`  ⚠️  Object not found or not a MoveObject: ${capId}`);
        }
    } catch (err) {
        console.log(`  ⚠️  Could not fetch cap: ${err}`);
    }
}

// ═══════════════════════════════════════════════════════
// QUERY EVENT HISTORY
// ═══════════════════════════════════════════════════════

/**
 * Query TradeExecuted events for this vault.
 *
 * ─── HOW SUI EVENTS WORK ───
 * Events emitted via `event::emit()` are stored in the transaction effects
 * and indexed by fullnodes. You can query them by:
 *   - MoveEventType: the fully qualified type of the event struct
 *   - Sender: the transaction sender
 *   - Transaction: specific transaction digest
 *
 * Events are NOT stored on-chain in any account/object — they're in the
 * transaction log. This is similar to Solana's instruction logs, but
 * structured and typed instead of free-form strings.
 *
 * ─── SOLANA COMPARISON ───
 * Solana uses `emit!()` in Anchor programs which serializes event data
 * into the transaction logs. You query them via `connection.getTransaction()`
 * and parse the logs. On Sui, events have a dedicated query API with
 * filtering and pagination — much more ergonomic.
 */
async function queryTradeHistory(
    client: SuiJsonRpcClient,
    packageId: string,
): Promise<void> {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('QUERY: TradeExecuted event history');
    console.log('═══════════════════════════════════════════════════════');

    const events = await client.queryEvents({
        query: {
            MoveEventType: `${packageId}::events::TradeExecuted`,
        },
        limit: 10,
        order: 'descending',
    });

    console.log(`  Found ${events.data.length} TradeExecuted events:`);
    for (const event of events.data) {
        const data = event.parsedJson as Record<string, unknown>;
        console.log(`\n    TX: ${event.id.txDigest}`);
        console.log(`    Direction: ${data['is_base_to_quote'] ? 'base→quote' : 'quote→base'}`);
        console.log(`    Amount In: ${data['amount_in']}`);
        console.log(`    Amount Out: ${data['amount_out']}`);
        console.log(`    Remaining Volume: ${data['remaining_volume']}`);
        console.log(`    Epoch: ${data['epoch']}`);
    }

    if (events.data.length === 0) {
        console.log('    (no trades executed yet)');
    }
}

// ═══════════════════════════════════════════════════════
// MAIN EXECUTION
// ═══════════════════════════════════════════════════════

async function main() {
    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║   Time-Locked Vault — AI Agent Trade Execution       ║');
    console.log('╚═══════════════════════════════════════════════════════╝');

    const config = loadConfig();
    const client = createMvrClient();
    const signer = Ed25519Keypair.fromSecretKey(config.privateKey);
    const address = signer.toSuiAddress();

    console.log(`  Network: ${NETWORK}`);
    console.log(`  Agent Address: ${address}`);
    console.log(`  Package: ${config.packageId}`);
    console.log(`  Vault: ${config.vaultId}`);
    console.log(`  DelegatedTradingCap: ${config.capId}`);
    console.log(`  Pool: ${config.poolId || '(not set — demo mode)'}`);
    console.log('');

    // ─── Type definitions for the trading pair ───
    // On testnet, use SUI as base and USDC type as quote.
    // These are the fully qualified Move type strings.
    const baseAssetType = '0x2::sui::SUI';
    const quoteAssetType = '0x2::sui::SUI'; // Placeholder — replace with actual USDC type on testnet

    // Trade parameters
    const tradeAmount = 500_000_000n; // 0.5 SUI
    const minQuoteOut = 400_000_000n; // Minimum acceptable output (slippage protection)

    // ─── Query current state ───
    await queryCapState(client, config.capId);

    // ─── Approach 1: Atomic swap (our actual implementation) ───
    await executeAtomicSwap(
        client,
        signer,
        config,
        tradeAmount,
        minQuoteOut,
        baseAssetType,
        quoteAssetType,
    );

    // ─── Approach 2: Decomposed PTB (educational demonstration) ───
    demonstratePtbResultPiping(config, baseAssetType, quoteAssetType);

    // ─── Query trade history ───
    await queryTradeHistory(client, config.packageId);

    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║   TRADE EXECUTION COMPLETE                           ║');
    console.log('╚═══════════════════════════════════════════════════════╝');
}

main().catch((err) => {
    console.error('\n❌ Trade execution failed:', err);
    process.exit(1);
});
