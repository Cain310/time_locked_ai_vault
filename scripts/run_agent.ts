/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * run_agent.ts — Autonomous AI Trading Agent Loop
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This is the main entry point for the AI trading agent. It runs a polling loop
 * that every N seconds:
 *   1. Queries vault state + market data from on-chain
 *   2. Sends context to OpenRouter LLM for a trading decision
 *   3. Validates the decision against cap constraints
 *   4. If approved, constructs a PTB, dry-runs it, and optionally executes
 *   5. Logs everything (decisions, trade results, errors) to stdout + audit log
 *   6. Stops when cap volume is exhausted or max errors exceeded
 *
 * Usage:
 *   # Required environment variables:
 *   export SUI_PRIVATE_KEY="suiprivkey1..."
 *   export PACKAGE_ID="0xa249bf144da12ebdb2e2bb672531cd4be0cbd671110761b07828b515609ef268"
 *   export VAULT_ID="0xf4b642394cc4597e2bfaa73c12dc162d8da9e40fe3fc6bb8b56a251872ca6cb2"
 *   export CAP_ID="0x..."  # DelegatedTradingCap (mint one first via manage_vault.ts)
 *   export POOL_ID="0x..."  # DeepBook V3 pool
 *   export OPENROUTER_API_KEY="sk-or-v1-..."
 *
 *   # Optional overrides:
 *   export OPENROUTER_MODEL="anthropic/claude-sonnet-4-20250514"
 *   export BASE_ASSET_TYPE="0x2::sui::SUI"
 *   export QUOTE_ASSET_TYPE="0x...::DBUSDC::DBUSDC"
 *   export DEEP_ASSET_TYPE="0x...::deep::DEEP"
 *   export POLL_INTERVAL_MS="30000"      # 30 seconds between cycles
 *   export EXECUTE_REAL_TRADES="false"   # true to execute, false for dry-run only
 *   export MAX_CONSECUTIVE_ERRORS="5"    # halt after this many sequential errors
 *
 *   # Run:
 *   npx tsx run_agent.ts
 *
 * Safety Features:
 *   - Dry-run every trade before execution
 *   - Client-side pre-validation (mirrors on-chain 6 assertions)
 *   - Halts on consecutive errors (prevents runaway failures)
 *   - Halts when cap volume is exhausted (no wasted gas)
 *   - Full audit log of every decision for transparency
 *   - Graceful shutdown on SIGINT (Ctrl+C)
 *
 * ─── ARCHITECTURE NOTE ───
 * The agent never has custody of vault funds. It holds a DelegatedTradingCap
 * which grants bounded, time-limited trading authority. The vault owner can
 * revoke this authority at any time via a single O(1) version bump.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
    type AgentConfig,
    type VaultState,
    type CapState,
    type MarketData,
    type TradingDecision,
    type TradeResult,
    loadAgentConfig,
    createClient,
    createSigner,
    queryVaultState,
    queryCapState,
    queryMarketData,
    queryLLMDecision,
    validateDecision,
    executeTrade,
    recordAuditEntry,
    printAuditEntry,
    getAuditLog,
    queryTradeHistory,
} from './agent.js';

import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

// ═══════════════════════════════════════════════════════
// AGENT STATE
// ═══════════════════════════════════════════════════════

interface AgentState {
    /** Whether the agent loop is running */
    running: boolean;
    /** Number of completed cycles */
    cycleCount: number;
    /** Number of consecutive errors */
    consecutiveErrors: number;
    /** Total trades executed (dry-run or real) */
    totalTrades: number;
    /** Total trades that succeeded */
    successfulTrades: number;
    /** Whether the cap is exhausted (stop condition) */
    capExhausted: boolean;
    /** Start time of the agent */
    startTime: string;
}

// ═══════════════════════════════════════════════════════
// BANNER & STATUS DISPLAY
// ═══════════════════════════════════════════════════════

function printBanner(config: AgentConfig, agentAddress: string): void {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║   ⚡ Time-Locked Vault — Autonomous AI Trading Agent ⚡      ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('  Configuration:');
    console.log(`    Network:          ${config.network}`);
    console.log(`    Agent Address:    ${agentAddress}`);
    console.log(`    Package:          ${config.packageId}`);
    console.log(`    Vault:            ${config.vaultId}`);
    console.log(`    Cap:              ${config.capId}`);
    console.log(`    Pool:             ${config.poolId}`);
    console.log(`    Base Asset:       ${config.baseAssetType}`);
    console.log(`    Quote Asset:      ${config.quoteAssetType}`);
    console.log(`    LLM Model:        ${config.openRouterModel}`);
    console.log(`    Poll Interval:    ${config.pollIntervalMs}ms`);
    console.log(`    Execute Trades:   ${config.executeRealTrades ? '🟢 YES (live)' : '🟡 NO (dry-run only)'}`);
    console.log(`    Max Errors:       ${config.maxConsecutiveErrors}`);
    console.log('');
}

function printCycleHeader(state: AgentState): void {
    console.log('');
    console.log(`╔═══════════════════════════════════════════════════════════════╗`);
    console.log(`║  Cycle #${state.cycleCount + 1} — ${new Date().toISOString()}`);
    console.log(`║  Trades: ${state.totalTrades} executed, ${state.successfulTrades} succeeded`);
    console.log(`╚═══════════════════════════════════════════════════════════════╝`);
}

function printAgentSummary(state: AgentState): void {
    const duration = Date.now() - new Date(state.startTime).getTime();
    const durationMin = (duration / 60000).toFixed(1);

    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║   🛑 Agent Shutdown Summary                                  ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log(`  Runtime:           ${durationMin} minutes`);
    console.log(`  Cycles:            ${state.cycleCount}`);
    console.log(`  Total Trades:      ${state.totalTrades}`);
    console.log(`  Successful:        ${state.successfulTrades}`);
    console.log(`  Cap Exhausted:     ${state.capExhausted}`);
    console.log(`  Audit Log Entries: ${getAuditLog().length}`);
    console.log('');
}

// ═══════════════════════════════════════════════════════
// SINGLE CYCLE
// ═══════════════════════════════════════════════════════

/**
 * Execute a single agent cycle:
 *   1. Query state
 *   2. Get LLM decision
 *   3. Validate
 *   4. Execute (if approved)
 *   5. Log
 */
async function runCycle(
    client: SuiJsonRpcClient,
    signer: Ed25519Keypair,
    config: AgentConfig,
    state: AgentState,
): Promise<void> {
    printCycleHeader(state);

    // ─── STEP 1: Query on-chain state ───
    console.log('\n  📊 Step 1: Querying on-chain state...');

    let vaultState: VaultState;
    let capState: CapState;
    let marketData: MarketData;

    try {
        vaultState = await queryVaultState(client, config.vaultId);
        console.log(`    Vault: version=${vaultState.version}, trading=${vaultState.tradingEnabled}`);
        const balanceCount = Object.keys(vaultState.balances).length;
        console.log(`    Balances: ${balanceCount} asset type(s)`);
        for (const [type, amount] of Object.entries(vaultState.balances)) {
            const shortType = type.split('::').pop() ?? type;
            console.log(`      ${shortType}: ${Number(amount) / 1e9}`);
        }
    } catch (err) {
        console.error(`    ❌ Failed to query vault state: ${err}`);
        throw err;
    }

    try {
        marketData = await queryMarketData(
            client,
            config.poolId,
            config.baseAssetType,
            config.quoteAssetType,
        );
        console.log(`    Market: mid=${marketData.midPrice}, epoch=${marketData.currentEpoch}`);
    } catch (err) {
        console.error(`    ❌ Failed to query market data: ${err}`);
        throw err;
    }

    try {
        capState = await queryCapState(
            client,
            config.capId,
            vaultState.version,
            marketData.currentEpoch,
        );
        console.log(`    Cap: valid=${capState.isValid}, remaining=${Number(capState.remainingTradeVolume) / 1e9}`);
        if (capState.invalidReason) {
            console.log(`      ⚠️  ${capState.invalidReason}`);
        }
    } catch (err) {
        console.error(`    ❌ Failed to query cap state: ${err}`);
        throw err;
    }

    // ─── CHECK: Cap exhausted → stop ───
    if (!capState.isValid && capState.remainingTradeVolume === 0n) {
        console.log('\n  🛑 Cap trade volume exhausted — stopping agent');
        state.capExhausted = true;
        state.running = false;
        recordAuditEntry(vaultState, capState, marketData, {
            action: 'hold',
            amount: 0,
            minOutput: 0,
            reason: 'Cap exhausted — agent stopping',
            model: 'system',
            rawResponse: '',
            timestamp: new Date().toISOString(),
        }, null);
        return;
    }

    // ─── CHECK: Cap revoked or expired → stop ───
    if (!capState.isValid) {
        console.log(`\n  🛑 Cap is invalid: ${capState.invalidReason}`);
        console.log('     Agent will hold but continue polling in case cap is re-minted');
        const holdDecision: TradingDecision = {
            action: 'hold',
            amount: 0,
            minOutput: 0,
            reason: `Cap invalid: ${capState.invalidReason}`,
            model: 'system',
            rawResponse: '',
            timestamp: new Date().toISOString(),
        };
        const entry = recordAuditEntry(vaultState, capState, marketData, holdDecision, null);
        printAuditEntry(entry);
        return;
    }

    // ─── STEP 2: Get LLM trading decision ───
    console.log('\n  🤖 Step 2: Querying OpenRouter LLM for trading decision...');
    console.log(`    Model: ${config.openRouterModel}`);

    let decision: TradingDecision;
    try {
        decision = await queryLLMDecision(config, vaultState, capState, marketData);
        console.log(`    Decision: ${decision.action.toUpperCase()}`);
        if (decision.amount > 0) {
            console.log(`    Amount: ${Number(decision.amount) / 1e9} (${decision.amount} MIST)`);
            console.log(`    Min Output: ${Number(decision.minOutput) / 1e9} (${decision.minOutput} MIST)`);
        }
        console.log(`    Reason: ${decision.reason}`);
    } catch (err) {
        console.error(`    ❌ LLM query failed: ${err}`);
        // Default to hold on LLM failure
        decision = {
            action: 'hold',
            amount: 0,
            minOutput: 0,
            reason: `LLM query failed: ${err}`,
            model: config.openRouterModel,
            rawResponse: '',
            timestamp: new Date().toISOString(),
        };
    }

    // ─── STEP 3: Validate decision ───
    console.log('\n  ✅ Step 3: Validating decision against constraints...');
    const validation = validateDecision(decision, capState, vaultState, config);

    if (!validation.valid) {
        console.log(`    ❌ Validation failed: ${validation.reason}`);
        console.log('    → Overriding to HOLD');
        decision = {
            ...decision,
            action: 'hold',
            amount: 0,
            minOutput: 0,
            reason: `Validation override: ${validation.reason}. Original: ${decision.reason}`,
        };
    } else {
        console.log('    ✅ Decision passes all constraint checks');
    }

    // ─── STEP 4: Execute (or skip if hold) ───
    let tradeResult: TradeResult | null = null;

    if (decision.action !== 'hold') {
        console.log('\n  🔧 Step 4: Constructing and executing trade PTB...');
        console.log(`    Direction: ${decision.action === 'buy' ? 'base→quote' : 'quote→base'}`);
        console.log(`    Amount: ${Number(decision.amount) / 1e9}`);
        console.log(`    Slippage floor: ${Number(decision.minOutput) / 1e9}`);

        try {
            tradeResult = await executeTrade(client, signer, config, decision);
            state.totalTrades++;

            if (tradeResult.success) {
                state.successfulTrades++;
                console.log(`    ✅ Trade succeeded!`);
                if (tradeResult.txDigest) {
                    console.log(`    TX: ${tradeResult.txDigest}`);
                    console.log(`    Explorer: https://suiscan.xyz/testnet/tx/${tradeResult.txDigest}`);
                }
            } else {
                console.log(`    ❌ Trade failed: ${tradeResult.error}`);
            }
        } catch (err) {
            console.error(`    ❌ Trade execution error: ${err}`);
            tradeResult = {
                success: false,
                dryRunStatus: 'error',
                error: `Execution exception: ${err}`,
                timestamp: new Date().toISOString(),
            };
            state.totalTrades++;
        }
    } else {
        console.log('\n  💤 Step 4: Holding — no trade this cycle');
    }

    // ─── STEP 5: Audit log ───
    const entry = recordAuditEntry(vaultState, capState, marketData, decision, tradeResult);
    printAuditEntry(entry);

    // Reset consecutive errors on successful cycle
    state.consecutiveErrors = 0;
}

// ═══════════════════════════════════════════════════════
// MAIN AGENT LOOP
// ═══════════════════════════════════════════════════════

async function main(): Promise<void> {
    // ─── Load configuration ───
    const config = loadAgentConfig();
    const client = createClient(config.network);
    const signer = createSigner();
    const agentAddress = signer.toSuiAddress();

    printBanner(config, agentAddress);

    // ─── Verify agent has gas ───
    console.log('  🔎 Preflight checks...');
    try {
        const balance = await client.getBalance({ owner: agentAddress });
        const suiBalance = Number(balance.totalBalance) / 1e9;
        console.log(`    Agent SUI balance: ${suiBalance} SUI`);

        if (suiBalance < 0.1) {
            console.error('    ⚠️  Low balance — agent may not have enough gas for trades');
            console.error('    Request testnet SUI from: https://faucet.sui.io/');
        }
    } catch (err) {
        console.error(`    ❌ Failed to check balance: ${err}`);
    }

    // ─── Query existing trade history ───
    try {
        const history = await queryTradeHistory(client, config.packageId, 5);
        console.log(`    Previous trades found: ${history.length}`);
        for (const trade of history) {
            const d = trade.data;
            console.log(`      TX: ${trade.txDigest}`);
            console.log(`        ${d['is_base_to_quote'] ? 'base→quote' : 'quote→base'}: ${d['amount_in']} → ${d['amount_out']}`);
        }
    } catch {
        console.log('    No previous trade history found');
    }

    console.log('');
    console.log('  ═══════════════════════════════════════════════════════');
    console.log('  🚀 Agent starting — press Ctrl+C to stop gracefully');
    console.log('  ═══════════════════════════════════════════════════════');

    // ─── Initialize agent state ───
    const state: AgentState = {
        running: true,
        cycleCount: 0,
        consecutiveErrors: 0,
        totalTrades: 0,
        successfulTrades: 0,
        capExhausted: false,
        startTime: new Date().toISOString(),
    };

    // ─── Graceful shutdown handler ───
    const shutdown = (): void => {
        console.log('\n\n  ⚡ Shutdown signal received — completing current cycle...');
        state.running = false;
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // ─── Main polling loop ───
    while (state.running) {
        try {
            await runCycle(client, signer, config, state);
            state.cycleCount++;
        } catch (err) {
            state.consecutiveErrors++;
            state.cycleCount++;
            console.error(`\n  ❌ Cycle error (#${state.consecutiveErrors}): ${err}`);

            if (state.consecutiveErrors >= config.maxConsecutiveErrors) {
                console.error(`\n  🛑 Max consecutive errors reached (${config.maxConsecutiveErrors}) — halting agent`);
                state.running = false;
                break;
            }
        }

        // ─── Check stop conditions ───
        if (!state.running || state.capExhausted) {
            break;
        }

        // ─── Wait for next cycle ───
        console.log(`\n  ⏳ Waiting ${config.pollIntervalMs / 1000}s until next cycle...`);
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, config.pollIntervalMs);
            // Allow shutdown to interrupt the wait
            const checkRunning = setInterval(() => {
                if (!state.running) {
                    clearTimeout(timer);
                    clearInterval(checkRunning);
                    resolve();
                }
            }, 500);
            // Clean up interval when timer fires normally
            setTimeout(() => clearInterval(checkRunning), config.pollIntervalMs + 100);
        });
    }

    // ─── Shutdown summary ───
    printAgentSummary(state);

    // ─── Print full audit log summary ───
    const auditLog = getAuditLog();
    if (auditLog.length > 0) {
        console.log('  Full Audit Log:');
        console.log(`    Total entries: ${auditLog.length}`);
        const holds = auditLog.filter((e) => e.decision.action === 'hold').length;
        const buys = auditLog.filter((e) => e.decision.action === 'buy').length;
        const sells = auditLog.filter((e) => e.decision.action === 'sell').length;
        console.log(`    Hold: ${holds}, Buy: ${buys}, Sell: ${sells}`);

        const executed = auditLog.filter((e) => e.tradeResult !== null);
        const succeeded = executed.filter((e) => e.tradeResult?.success);
        console.log(`    Executed: ${executed.length}, Succeeded: ${succeeded.length}`);
    }

    // Clean up listeners
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
}

// ═══════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════

main().catch((err) => {
    console.error('\n❌ Agent fatal error:', err);
    process.exit(1);
});
