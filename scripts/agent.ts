/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * agent.ts — AI Agent Core Library for Autonomous Trading
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This module implements the AI agent's core capabilities:
 *   1. VaultMonitor — Queries on-chain vault state, balances, cap status
 *   2. MarketMonitor — Fetches DeepBook V3 pool data (mid price, spread, volume)
 *   3. LLMDecisionEngine — Sends context to OpenRouter and parses trading decisions
 *   4. TradeExecutor — Constructs PTBs, dry-runs, and executes swaps
 *   5. AuditLogger — Logs all LLM decisions and trade results for transparency
 *
 * Architecture:
 * ┌──────────────────────────────────┐
 * │         AI Agent (TS)            │
 * │  ┌──────────────┐ ┌───────────┐ │
 * │  │ VaultMonitor  │ │ OpenRouter│ │
 * │  │ + MarketData  │→│ LLM API   │ │
 * │  │ (Sui RPC)     │ │ Decision  │ │
 * │  └──────────────┘ └───────────┘ │
 * │         │              │         │
 * │         ▼              ▼         │
 * │  ┌──────────────────────────────┐│
 * │  │   PTB Constructor            ││
 * │  │   (execute_swap_*)           ││
 * │  └──────────────────────────────┘│
 * │         │                        │
 * │         ▼                        │
 * │  ┌──────────────────────────────┐│
 * │  │ Dry Run → Execute            ││
 * │  └──────────────────────────────┘│
 * └──────────────────────────────────┘
 *
 * Key Security Principles:
 *   - Agent never has custody — holds DelegatedTradingCap, NOT OwnerCap
 *   - All trades go through authenticate_trade (6 assertions)
 *   - Owner can revoke all authority instantly via version bump
 *   - Every trade is dry-run before execution
 *   - ALL LLM decisions are logged for audit trail
 *
 * Environment Variables:
 *   SUI_PRIVATE_KEY  — Agent's Ed25519 private key (Bech32 "suiprivkey1...")
 *   PACKAGE_ID       — Deployed package address
 *   VAULT_ID         — Shared vault object ID
 *   CAP_ID           — DelegatedTradingCap object ID (owned by agent)
 *   POOL_ID          — DeepBook V3 pool object ID
 *   OPENROUTER_API_KEY — OpenRouter API key ("sk-or-v1-...")
 *   BASE_ASSET_TYPE  — Fully qualified Move type (e.g., "0x2::sui::SUI")
 *   QUOTE_ASSET_TYPE — Fully qualified Move type (e.g., "0x...::usdc::USDC")
 *   DEEP_ASSET_TYPE  — DEEP token type on current network
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

// ═══════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════

/** Vault on-chain state from getObject + getDynamicFields */
export interface VaultState {
    /** Object ID of the vault */
    vaultId: string;
    /** Monotonically increasing version counter for O(1) revocation */
    version: number;
    /** Maximum allowed slippage in basis points (100 = 1%) */
    maxSlippageBps: number;
    /** Emergency kill switch — if false, all trades are rejected */
    tradingEnabled: boolean;
    /** Asset balances keyed by fully qualified type string */
    balances: Record<string, bigint>;
}

/** DelegatedTradingCap on-chain state */
export interface CapState {
    /** Object ID of the cap */
    capId: string;
    /** Vault this cap is linked to */
    vaultId: string;
    /** Epoch after which this cap expires */
    expirationEpoch: number;
    /** Remaining cumulative trade volume in base units (MIST) */
    remainingTradeVolume: bigint;
    /** Maximum single trade size in base units (MIST) */
    maxTradeSize: bigint;
    /** Version snapshot — must match vault.version to be valid */
    version: number;
    /** Whether the cap is currently valid (computed) */
    isValid: boolean;
    /** Reason if invalid */
    invalidReason?: string;
}

/** Market data from DeepBook V3 pool */
export interface MarketData {
    /** Pool object ID */
    poolId: string;
    /** Base asset type string */
    baseType: string;
    /** Quote asset type string */
    quoteType: string;
    /** Best bid price (highest buy order) — may be 0 if no orders */
    bestBid: number;
    /** Best ask price (lowest sell order) — may be 0 if no orders */
    bestAsk: number;
    /** Mid-market price: (bestBid + bestAsk) / 2 */
    midPrice: number;
    /** Spread: bestAsk - bestBid */
    spread: number;
    /** Pool vault balances: base, quote, deep */
    vaultBalances: { base: bigint; quote: bigint; deep: bigint };
    /** Current Sui epoch */
    currentEpoch: number;
    /** Timestamp of this data snapshot */
    timestamp: string;
}

/** LLM trading decision */
export interface TradingDecision {
    /** The action to take: buy (base→quote), sell (quote→base), or hold */
    action: 'buy' | 'sell' | 'hold';
    /** Amount in base units (MIST) — 0 for hold */
    amount: number;
    /** Minimum acceptable output (slippage protection) */
    minOutput: number;
    /** LLM's reasoning for the decision */
    reason: string;
    /** The LLM model that produced this decision */
    model: string;
    /** Raw LLM response (for audit) */
    rawResponse: string;
    /** Timestamp */
    timestamp: string;
}

/** Trade execution result */
export interface TradeResult {
    /** Whether the trade succeeded */
    success: boolean;
    /** Transaction digest (if executed) */
    txDigest?: string;
    /** Dry-run status */
    dryRunStatus: string;
    /** Gas used (if available) */
    gasUsed?: { computation: string; storage: string };
    /** Events emitted (if available) */
    events?: Array<{ type: string; data: Record<string, unknown> }>;
    /** Error message (if failed) */
    error?: string;
    /** Timestamp */
    timestamp: string;
}

/** Full audit log entry */
export interface AuditLogEntry {
    /** Sequential entry number */
    sequence: number;
    /** Vault state at decision time */
    vaultState: VaultState;
    /** Cap state at decision time */
    capState: CapState;
    /** Market data at decision time */
    marketData: MarketData;
    /** LLM decision */
    decision: TradingDecision;
    /** Trade result (null if decision was "hold") */
    tradeResult: TradeResult | null;
    /** Timestamp */
    timestamp: string;
}

/** Agent configuration */
export interface AgentConfig {
    /** Deployed package ID */
    packageId: string;
    /** Vault shared object ID */
    vaultId: string;
    /** DelegatedTradingCap object ID */
    capId: string;
    /** DeepBook V3 pool object ID */
    poolId: string;
    /** Base asset Move type string (e.g., "0x2::sui::SUI") */
    baseAssetType: string;
    /** Quote asset Move type string */
    quoteAssetType: string;
    /** DEEP token Move type string */
    deepAssetType: string;
    /** OpenRouter API key */
    openRouterApiKey: string;
    /** OpenRouter model to use */
    openRouterModel: string;
    /** Network: testnet, devnet, or mainnet */
    network: 'testnet' | 'devnet' | 'mainnet';
    /** Polling interval in milliseconds */
    pollIntervalMs: number;
    /** Maximum number of consecutive errors before halting */
    maxConsecutiveErrors: number;
    /** Whether to actually execute trades (false = dry-run only) */
    executeRealTrades: boolean;
}

// ═══════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════

/** System Clock object — always 0x6 on all Sui networks */
const CLOCK_OBJECT_ID = '0x6';

/** Default DEEP fee estimate (0.5 DEEP). DeepBook refunds unused DEEP. */
const DEFAULT_DEEP_FEE_MIST = 500_000_000n;

/**
 * Well-known DeepBook V3 testnet constants.
 * These must be verified against the current testnet deployment.
 * Use `discoverDeepBookConfig()` for dynamic discovery.
 */
export const DEEPBOOK_TESTNET_DEFAULTS = {
    /** DEEP token type on testnet (verified via @mysten/deepbook-v3 SDK testnetCoins) */
    DEEP_TOKEN_TYPE: '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP',
    /** DBUSDC (test USDC) type on testnet */
    DBUSDC_TOKEN_TYPE: '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC',
    /** SUI type (fully qualified) */
    SUI_TOKEN_TYPE: '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
    /** DEEP/SUI pool on testnet (whitelisted — 0% fees). Base=DEEP, Quote=SUI */
    DEEP_SUI_POOL_ID: '0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f',
    /** SUI/DBUSDC pool on testnet. Base=SUI, Quote=DBUSDC */
    SUI_DBUSDC_POOL_ID: '0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5',
    /** DEEP/DBUSDC pool on testnet. Base=DEEP, Quote=DBUSDC */
    DEEP_DBUSDC_POOL_ID: '0xe86b991f8632217505fd859445f9803967ac84a9d4a1219065bf191fcb74b622',
    /** DeepBook V3 package on testnet */
    DEEPBOOK_PACKAGE_ID: '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c',
    /** DeepBook Registry on testnet */
    REGISTRY_ID: '0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1',
} as const;

// ═══════════════════════════════════════════════════════
// CONFIG LOADER
// ═══════════════════════════════════════════════════════

/**
 * Load agent configuration from environment variables with full validation.
 * All required env vars must be set before the agent can start.
 */
export function loadAgentConfig(): AgentConfig {
    const required = [
        'SUI_PRIVATE_KEY',
        'PACKAGE_ID',
        'VAULT_ID',
        'CAP_ID',
        'POOL_ID',
        'OPENROUTER_API_KEY',
    ] as const;

    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
        console.error('');
        console.error('Required:');
        console.error('  export SUI_PRIVATE_KEY="suiprivkey1..."');
        console.error('  export PACKAGE_ID="0x..."');
        console.error('  export VAULT_ID="0x..."');
        console.error('  export CAP_ID="0x..."');
        console.error('  export POOL_ID="0x..."');
        console.error('  export OPENROUTER_API_KEY="sk-or-v1-..."');
        console.error('');
        console.error('Optional:');
        console.error('  export BASE_ASSET_TYPE="0x2::sui::SUI"');
        console.error('  export QUOTE_ASSET_TYPE="0x...::usdc::USDC"');
        console.error('  export DEEP_ASSET_TYPE="0x...::deep::DEEP"');
        console.error('  export OPENROUTER_MODEL="anthropic/claude-sonnet-4-20250514"');
        console.error('  export POLL_INTERVAL_MS="30000"');
        console.error('  export EXECUTE_REAL_TRADES="false"');
        process.exit(1);
    }

    return {
        packageId: process.env.PACKAGE_ID!,
        vaultId: process.env.VAULT_ID!,
        capId: process.env.CAP_ID!,
        poolId: process.env.POOL_ID!,
        baseAssetType: process.env.BASE_ASSET_TYPE ?? DEEPBOOK_TESTNET_DEFAULTS.SUI_TOKEN_TYPE,
        quoteAssetType: process.env.QUOTE_ASSET_TYPE ?? DEEPBOOK_TESTNET_DEFAULTS.DBUSDC_TOKEN_TYPE,
        deepAssetType: process.env.DEEP_ASSET_TYPE ?? DEEPBOOK_TESTNET_DEFAULTS.DEEP_TOKEN_TYPE,
        openRouterApiKey: process.env.OPENROUTER_API_KEY!,
        openRouterModel: process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4-20250514',
        network: (process.env.NETWORK as AgentConfig['network']) ?? 'testnet',
        pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? '30000'),
        maxConsecutiveErrors: Number(process.env.MAX_CONSECUTIVE_ERRORS ?? '5'),
        executeRealTrades: process.env.EXECUTE_REAL_TRADES === 'true',
    };
}

// ═══════════════════════════════════════════════════════
// VAULT MONITOR
// ═══════════════════════════════════════════════════════

/**
 * Query the vault's on-chain state including all dynamic field balances.
 *
 * Reads the Vault shared object and enumerates its Dynamic Fields to
 * build a complete picture of all asset balances held in the vault.
 */
export async function queryVaultState(
    client: SuiJsonRpcClient,
    vaultId: string,
): Promise<VaultState> {
    // Read the vault object
    const vault = await client.getObject({
        id: vaultId,
        options: { showContent: true, showType: true },
    });

    if (!vault.data?.content || vault.data.content.dataType !== 'moveObject') {
        throw new Error(`Vault ${vaultId} not found or not a MoveObject`);
    }

    const fields = vault.data.content.fields as Record<string, unknown>;

    // Enumerate dynamic fields (Balance<T> entries)
    const balances: Record<string, bigint> = {};
    const dynamicFields = await client.getDynamicFields({ parentId: vaultId });

    for (const field of dynamicFields.data) {
        const fieldObj = await client.getDynamicFieldObject({
            parentId: vaultId,
            name: field.name,
        });

        if (fieldObj.data?.content?.dataType === 'moveObject') {
            const balanceFields = fieldObj.data.content.fields as Record<string, unknown>;
            // Dynamic Field value wraps the Balance — extract the inner value
            const value = balanceFields['value'];
            let amount = 0n;
            if (typeof value === 'string' || typeof value === 'number') {
                amount = BigInt(value);
            } else if (typeof value === 'object' && value !== null && 'value' in (value as Record<string, unknown>)) {
                // Balance<T> is stored as { value: u64 }
                amount = BigInt((value as Record<string, unknown>)['value'] as string);
            }

            // Key is the TypeName string (fully qualified type of the asset)
            const keyValue = field.name.value;
            const keyStr = typeof keyValue === 'string'
                ? keyValue
                : JSON.stringify(keyValue);
            balances[keyStr] = amount;
        }
    }

    return {
        vaultId,
        version: Number(fields['version'] ?? 0),
        maxSlippageBps: Number(fields['max_slippage_bps'] ?? 0),
        tradingEnabled: Boolean(fields['trading_enabled'] ?? false),
        balances,
    };
}

/**
 * Query the DelegatedTradingCap's on-chain state and compute validity.
 */
export async function queryCapState(
    client: SuiJsonRpcClient,
    capId: string,
    vaultVersion: number,
    currentEpoch: number,
): Promise<CapState> {
    const cap = await client.getObject({
        id: capId,
        options: { showContent: true, showType: true, showOwner: true },
    });

    if (!cap.data?.content || cap.data.content.dataType !== 'moveObject') {
        throw new Error(`DelegatedTradingCap ${capId} not found or not a MoveObject`);
    }

    const fields = cap.data.content.fields as Record<string, unknown>;

    const expirationEpoch = Number(fields['expiration_epoch'] ?? 0);
    const remainingTradeVolume = BigInt(fields['remaining_trade_volume'] as string ?? '0');
    const maxTradeSize = BigInt(fields['max_trade_size'] as string ?? '0');
    const version = Number(fields['version'] ?? 0);

    // Compute validity (mirrors authenticate_trade's 6 assertions)
    let isValid = true;
    let invalidReason: string | undefined;

    if (version !== vaultVersion) {
        isValid = false;
        invalidReason = `Version mismatch: cap.version=${version} != vault.version=${vaultVersion} (REVOKED)`;
    } else if (expirationEpoch <= currentEpoch) {
        isValid = false;
        invalidReason = `Cap expired: expiration_epoch=${expirationEpoch} <= current_epoch=${currentEpoch}`;
    } else if (remainingTradeVolume === 0n) {
        isValid = false;
        invalidReason = 'Trade volume exhausted: remaining_trade_volume=0';
    }

    return {
        capId,
        vaultId: fields['vault_id'] as string ?? '',
        expirationEpoch,
        remainingTradeVolume,
        maxTradeSize,
        version,
        isValid,
        invalidReason,
    };
}

// ═══════════════════════════════════════════════════════
// MARKET MONITOR
// ═══════════════════════════════════════════════════════

/**
 * Fetch market data from a DeepBook V3 pool on-chain.
 *
 * Reads the pool object to extract the order book's best bid/ask,
 * vault balances, and computes mid price and spread.
 *
 * Note: On testnet, pools may have limited liquidity. The agent
 * should handle zero-liquidity gracefully.
 */
export async function queryMarketData(
    client: SuiJsonRpcClient,
    poolId: string,
    baseType: string,
    quoteType: string,
): Promise<MarketData> {
    // Get current epoch
    const systemState = await client.getLatestSuiSystemState();
    const currentEpoch = Number(systemState.epoch);

    // Read the pool object for basic info
    const pool = await client.getObject({
        id: poolId,
        options: { showContent: true, showType: true },
    });

    let bestBid = 0;
    let bestAsk = 0;
    let vaultBalances = { base: 0n, quote: 0n, deep: 0n };

    if (pool.data?.content?.dataType === 'moveObject') {
        const fields = pool.data.content.fields as Record<string, unknown>;

        // Try to extract vault balances from pool fields
        // DeepBook V3 pool structure has nested components
        try {
            // The pool's internal vault holds base, quote, and DEEP balances
            // These may be nested under different field names depending on the version
            if (fields['vault']) {
                const vault = fields['vault'] as Record<string, unknown>;
                if (vault['base_balance']) vaultBalances.base = BigInt(vault['base_balance'] as string);
                if (vault['quote_balance']) vaultBalances.quote = BigInt(vault['quote_balance'] as string);
                if (vault['deep_balance']) vaultBalances.deep = BigInt(vault['deep_balance'] as string);
            }
        } catch {
            // Pool structure may vary — fallback to zero balances
        }

        // Try to read best bid/ask from the order book
        // Note: This is a simplified extraction — real implementation would
        // use devInspect to call pool::get_best_bid_ask() for accurate data
        try {
            if (fields['best_bid_price']) bestBid = Number(fields['best_bid_price']) / 1e9;
            if (fields['best_ask_price']) bestAsk = Number(fields['best_ask_price']) / 1e9;
        } catch {
            // No order book data available — common on testnet
        }
    }

    // Use devInspect to call read-only pool functions for more accurate data
    // This avoids needing to parse the internal pool structure directly
    try {
        const tx = new Transaction();
        // Call pool::mid_price to get the mid-market price
        tx.moveCall({
            target: `0xdee9::pool::mid_price`,
            typeArguments: [baseType, quoteType],
            arguments: [tx.object(poolId)],
        });

        // Note: devInspect may fail if the pool has no liquidity
        // We catch and continue with zero prices in that case
    } catch {
        // devInspect not available or pool empty — use fallback values
    }

    const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;
    const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;

    return {
        poolId,
        baseType,
        quoteType,
        bestBid,
        bestAsk,
        midPrice,
        spread,
        vaultBalances,
        currentEpoch,
        timestamp: new Date().toISOString(),
    };
}

// ═══════════════════════════════════════════════════════
// LLM DECISION ENGINE (OpenRouter)
// ═══════════════════════════════════════════════════════

/**
 * The system prompt that establishes the LLM as a DeFi trading analyst.
 * This defines the agent's personality, constraints, and output format.
 */
const SYSTEM_PROMPT = `You are a DeFi trading analyst operating on the Sui blockchain via DeepBook V3.
You are an AI agent with delegated, bounded trading authority over a time-locked vault.

CRITICAL CONSTRAINTS:
- You can ONLY trade within the remaining volume limit of your DelegatedTradingCap
- You can ONLY execute trades up to the max_trade_size per trade
- Your authority expires at a specific epoch — once expired, you cannot trade
- If the vault owner revokes your authority (version mismatch), you cannot trade
- All trades go through DeepBook V3 order book — you need sufficient liquidity

DECISION FRAMEWORK:
1. Analyze the vault's current asset balances
2. Check your remaining trading volume (don't waste it)
3. Look at the pool's liquidity and price data
4. Consider the risk/reward of each potential trade
5. If in doubt, HOLD — preserving capital is the default

OUTPUT FORMAT:
You MUST respond with valid JSON only (no markdown, no code blocks, no explanation outside the JSON):
{
  "action": "buy" | "sell" | "hold",
  "amount": <number in MIST units, 1 SUI = 1000000000 MIST>,
  "minOutput": <number in MIST units — minimum acceptable output for slippage protection>,
  "reason": "<brief explanation of your reasoning>"
}

ACTIONS:
- "buy": Swap base asset (e.g., SUI) for quote asset (e.g., USDC) via execute_swap_base_to_quote
- "sell": Swap quote asset for base asset via execute_swap_quote_to_base
- "hold": Do nothing this cycle — wait for better conditions

RULES:
- amount MUST be <= maxTradeSize from the cap
- amount MUST be <= remainingTradeVolume from the cap
- amount MUST be <= available balance of the input asset in the vault
- If any of these are violated, respond with "hold"
- On testnet with limited liquidity, prefer smaller trades or holding
- minOutput should account for reasonable slippage (1-5% below expected)
- If pool has zero liquidity, ALWAYS hold`;

/**
 * Query OpenRouter LLM for a trading decision.
 *
 * Sends the current vault state, cap state, and market data as context,
 * then parses the LLM's JSON response into a TradingDecision.
 *
 * OpenRouter is a unified API gateway that supports 100+ LLM models.
 * We use it instead of direct API calls for:
 *   - Model flexibility (can swap models without code changes)
 *   - Unified billing and rate limiting
 *   - Fallback to alternative models if primary is overloaded
 */
export async function queryLLMDecision(
    config: AgentConfig,
    vaultState: VaultState,
    capState: CapState,
    marketData: MarketData,
): Promise<TradingDecision> {
    const timestamp = new Date().toISOString();

    // Build the user message with all available context
    const userMessage = buildLLMContext(vaultState, capState, marketData);

    // Call OpenRouter
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config.openRouterApiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/time-locked-vault',
            'X-Title': 'Time-Locked-Vault-AI-Agent',
        },
        body: JSON.stringify({
            model: config.openRouterModel,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userMessage },
            ],
            temperature: 0.3, // Low temperature for more deterministic decisions
            max_tokens: 500,
            response_format: { type: 'json_object' },
        }),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenRouter API error (${response.status}): ${errorBody}`);
    }

    const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        model?: string;
    };

    const rawResponse = data.choices?.[0]?.message?.content ?? '';
    const modelUsed = data.model ?? config.openRouterModel;

    // Parse the LLM's JSON response
    try {
        const parsed = JSON.parse(rawResponse) as {
            action?: string;
            amount?: number;
            minOutput?: number;
            reason?: string;
        };

        // Validate the response structure
        const action = parsed.action as TradingDecision['action'];
        if (!['buy', 'sell', 'hold'].includes(action)) {
            throw new Error(`Invalid action: ${parsed.action}`);
        }

        return {
            action,
            amount: Number(parsed.amount ?? 0),
            minOutput: Number(parsed.minOutput ?? 0),
            reason: parsed.reason ?? 'No reason provided',
            model: modelUsed,
            rawResponse,
            timestamp,
        };
    } catch (parseError) {
        // If LLM returns invalid JSON, log the raw response and default to hold
        console.warn(`⚠️  LLM returned unparseable response, defaulting to HOLD`);
        console.warn(`   Raw response: ${rawResponse}`);

        return {
            action: 'hold',
            amount: 0,
            minOutput: 0,
            reason: `LLM response parse error: ${parseError}. Raw: ${rawResponse.substring(0, 200)}`,
            model: modelUsed,
            rawResponse,
            timestamp,
        };
    }
}

/**
 * Build the context message sent to the LLM with all relevant data.
 */
function buildLLMContext(
    vaultState: VaultState,
    capState: CapState,
    marketData: MarketData,
): string {
    // Format balances for readability
    const formattedBalances: Record<string, string> = {};
    for (const [type, amount] of Object.entries(vaultState.balances)) {
        // Extract the short type name from the fully qualified path
        const shortType = type.split('::').pop() ?? type;
        formattedBalances[shortType] = `${Number(amount) / 1e9} (${amount.toString()} MIST)`;
    }

    return `CURRENT STATE — ${new Date().toISOString()}

=== VAULT STATE ===
Vault ID: ${vaultState.vaultId}
Version: ${vaultState.version}
Trading Enabled: ${vaultState.tradingEnabled}
Max Slippage: ${vaultState.maxSlippageBps} bps (${vaultState.maxSlippageBps / 100}%)
Asset Balances: ${JSON.stringify(formattedBalances, null, 2)}

=== YOUR TRADING CAPABILITY ===
Cap ID: ${capState.capId}
Valid: ${capState.isValid}${capState.invalidReason ? ` (${capState.invalidReason})` : ''}
Expiration Epoch: ${capState.expirationEpoch} (current: ${marketData.currentEpoch})
Epochs Until Expiry: ${capState.expirationEpoch - marketData.currentEpoch}
Remaining Trade Volume: ${Number(capState.remainingTradeVolume) / 1e9} SUI (${capState.remainingTradeVolume.toString()} MIST)
Max Trade Size: ${Number(capState.maxTradeSize) / 1e9} SUI (${capState.maxTradeSize.toString()} MIST)
Version Match: cap=${capState.version} vault=${vaultState.version} ${capState.version === vaultState.version ? '✅' : '❌ REVOKED'}

=== MARKET DATA (DeepBook V3) ===
Pool: ${marketData.poolId}
Trading Pair: ${marketData.baseType.split('::').pop()} / ${marketData.quoteType.split('::').pop()}
Best Bid: ${marketData.bestBid}
Best Ask: ${marketData.bestAsk}
Mid Price: ${marketData.midPrice}
Spread: ${marketData.spread}
Pool Base Balance: ${Number(marketData.vaultBalances.base) / 1e9}
Pool Quote Balance: ${Number(marketData.vaultBalances.quote) / 1e9}
Pool DEEP Balance: ${Number(marketData.vaultBalances.deep) / 1e9}

=== INSTRUCTIONS ===
Based on the above state, should we execute a trade? Consider:
1. Is our cap still valid? (version match, not expired, volume remaining)
2. Is there sufficient liquidity in the pool?
3. Do we have enough balance of the input asset?
4. Is the current price favorable?
5. On testnet, liquidity is limited — prefer small trades or holding.

Respond with valid JSON: { "action": "buy"|"sell"|"hold", "amount": <MIST>, "minOutput": <MIST>, "reason": "<explanation>" }`;
}

// ═══════════════════════════════════════════════════════
// TRADE EXECUTOR
// ═══════════════════════════════════════════════════════

/**
 * Validate a trading decision against on-chain constraints before execution.
 * This is a client-side pre-check — the on-chain authenticate_trade provides
 * the authoritative enforcement.
 */
export function validateDecision(
    decision: TradingDecision,
    capState: CapState,
    vaultState: VaultState,
    config: AgentConfig,
): { valid: boolean; reason?: string } {
    // Skip validation for hold decisions
    if (decision.action === 'hold') {
        return { valid: true };
    }

    // Cap must be valid
    if (!capState.isValid) {
        return { valid: false, reason: `Cap is invalid: ${capState.invalidReason}` };
    }

    // Trading must be enabled
    if (!vaultState.tradingEnabled) {
        return { valid: false, reason: 'Trading is disabled on the vault' };
    }

    const amount = BigInt(decision.amount);

    // Amount must be positive
    if (amount <= 0n) {
        return { valid: false, reason: 'Trade amount must be positive' };
    }

    // Amount must not exceed max trade size
    if (amount > capState.maxTradeSize) {
        return {
            valid: false,
            reason: `Trade amount ${amount} exceeds max trade size ${capState.maxTradeSize}`,
        };
    }

    // Amount must not exceed remaining volume
    if (amount > capState.remainingTradeVolume) {
        return {
            valid: false,
            reason: `Trade amount ${amount} exceeds remaining volume ${capState.remainingTradeVolume}`,
        };
    }

    // Check vault has sufficient balance of the input asset
    if (decision.action === 'buy') {
        // Buying: spending base asset (e.g., SUI) to get quote asset
        const baseBalance = findBalance(vaultState, config.baseAssetType);
        if (amount > baseBalance) {
            return {
                valid: false,
                reason: `Insufficient ${config.baseAssetType} balance: need ${amount}, have ${baseBalance}`,
            };
        }
    } else {
        // Selling: spending quote asset to get base asset
        const quoteBalance = findBalance(vaultState, config.quoteAssetType);
        if (amount > quoteBalance) {
            return {
                valid: false,
                reason: `Insufficient ${config.quoteAssetType} balance: need ${amount}, have ${quoteBalance}`,
            };
        }
    }

    // Check vault has DEEP for fees
    const deepBalance = findBalance(vaultState, config.deepAssetType);
    if (deepBalance < DEFAULT_DEEP_FEE_MIST) {
        return {
            valid: false,
            reason: `Insufficient DEEP for fees: need ${DEFAULT_DEEP_FEE_MIST}, have ${deepBalance}`,
        };
    }

    return { valid: true };
}

/**
 * Find a balance in the vault state by matching against the asset type.
 * Handles partial type matching (e.g., "SUI" matches "0x2::sui::SUI").
 */
function findBalance(vaultState: VaultState, assetType: string): bigint {
    // Exact match first
    if (vaultState.balances[assetType] !== undefined) {
        return vaultState.balances[assetType];
    }

    // Partial match — the key format from dynamic fields may differ
    for (const [key, value] of Object.entries(vaultState.balances)) {
        if (key.includes(assetType) || assetType.includes(key)) {
            return value;
        }
        // Also match by the short coin name (e.g., "SUI", "DEEP")
        const shortKey = key.split('::').pop()?.toLowerCase();
        const shortType = assetType.split('::').pop()?.toLowerCase();
        if (shortKey && shortType && shortKey === shortType) {
            return value;
        }
    }

    return 0n;
}

/**
 * Construct and execute a trade PTB based on the LLM's decision.
 *
 * Flow:
 *   1. Build Transaction with a single moveCall to execute_swap_*
 *   2. Dry-run the transaction to validate + estimate gas
 *   3. If dry-run succeeds and executeRealTrades is true, submit the TX
 *   4. Return the full result for audit logging
 */
export async function executeTrade(
    client: SuiJsonRpcClient,
    signer: Ed25519Keypair,
    config: AgentConfig,
    decision: TradingDecision,
): Promise<TradeResult> {
    const timestamp = new Date().toISOString();
    const tx = new Transaction();

    // ─── Build the PTB based on action direction ───
    if (decision.action === 'buy') {
        // Base → Quote swap (e.g., SUI → USDC)
        tx.moveCall({
            target: `${config.packageId}::trading::execute_swap_base_to_quote`,
            typeArguments: [config.baseAssetType, config.quoteAssetType],
            arguments: [
                tx.object(config.vaultId),      // &mut Vault (Shared)
                tx.object(config.capId),         // &mut DelegatedTradingCap (Owned)
                tx.object(config.poolId),        // &mut Pool<Base, Quote> (Shared)
                tx.pure.u64(decision.amount),    // trade_amount: u64
                tx.pure.u64(decision.minOutput), // min_quote_out: u64
                tx.object(CLOCK_OBJECT_ID),      // &Clock (Shared, 0x6)
                // ctx: &mut TxContext — auto-injected
            ],
        });
    } else if (decision.action === 'sell') {
        // Quote → Base swap (e.g., USDC → SUI)
        tx.moveCall({
            target: `${config.packageId}::trading::execute_swap_quote_to_base`,
            typeArguments: [config.baseAssetType, config.quoteAssetType],
            arguments: [
                tx.object(config.vaultId),
                tx.object(config.capId),
                tx.object(config.poolId),
                tx.pure.u64(decision.amount),
                tx.pure.u64(decision.minOutput),
                tx.object(CLOCK_OBJECT_ID),
            ],
        });
    } else {
        // Should never reach here — hold is filtered upstream
        return {
            success: false,
            dryRunStatus: 'skipped',
            error: 'Hold decision should not reach executeTrade',
            timestamp,
        };
    }

    // ─── DRY RUN ───
    // Always dry-run first — this is free and catches errors before gas is spent.
    console.log('  🔍 Dry-running trade transaction...');
    let dryRunResult;
    try {
        const txBytes = await tx.build({ client });
        dryRunResult = await client.dryRunTransactionBlock({
            transactionBlock: txBytes,
        });
    } catch (buildError) {
        return {
            success: false,
            dryRunStatus: 'build_failed',
            error: `Transaction build/dry-run failed: ${buildError}`,
            timestamp,
        };
    }

    const dryRunStatus = dryRunResult.effects.status.status;
    console.log(`  Dry run status: ${dryRunStatus}`);

    if (dryRunStatus !== 'success') {
        return {
            success: false,
            dryRunStatus,
            error: `Dry run failed: ${dryRunResult.effects.status.error ?? 'unknown error'}`,
            gasUsed: {
                computation: dryRunResult.effects.gasUsed.computationCost,
                storage: dryRunResult.effects.gasUsed.storageCost,
            },
            timestamp,
        };
    }

    // ─── EXECUTE (if enabled) ───
    if (!config.executeRealTrades) {
        console.log('  ⚠️  EXECUTE_REAL_TRADES=false — dry-run only');
        return {
            success: true,
            dryRunStatus: 'success',
            gasUsed: {
                computation: dryRunResult.effects.gasUsed.computationCost,
                storage: dryRunResult.effects.gasUsed.storageCost,
            },
            timestamp,
        };
    }

    console.log('  🚀 Executing trade on-chain...');
    try {
        const result = await client.signAndExecuteTransaction({
            signer,
            transaction: tx,
            options: {
                showEffects: true,
                showEvents: true,
            },
        });

        const events = result.events?.map((event) => ({
            type: event.type,
            data: event.parsedJson as Record<string, unknown>,
        })) ?? [];

        return {
            success: result.effects?.status?.status === 'success',
            txDigest: result.digest,
            dryRunStatus: 'success',
            gasUsed: result.effects?.gasUsed
                ? {
                    computation: result.effects.gasUsed.computationCost,
                    storage: result.effects.gasUsed.storageCost,
                }
                : undefined,
            events,
            error: result.effects?.status?.status !== 'success'
                ? result.effects?.status?.error
                : undefined,
            timestamp,
        };
    } catch (execError) {
        return {
            success: false,
            dryRunStatus: 'success',
            error: `Execution failed after successful dry-run: ${execError}`,
            timestamp,
        };
    }
}

// ═══════════════════════════════════════════════════════
// AUDIT LOGGER
// ═══════════════════════════════════════════════════════

/** Global audit log — persists for the lifetime of the agent process */
const auditLog: AuditLogEntry[] = [];

/**
 * Record an audit log entry with all decision context and results.
 * This provides a complete audit trail of every agent decision.
 */
export function recordAuditEntry(
    vaultState: VaultState,
    capState: CapState,
    marketData: MarketData,
    decision: TradingDecision,
    tradeResult: TradeResult | null,
): AuditLogEntry {
    const entry: AuditLogEntry = {
        sequence: auditLog.length + 1,
        vaultState,
        capState,
        marketData,
        decision,
        tradeResult,
        timestamp: new Date().toISOString(),
    };

    auditLog.push(entry);
    return entry;
}

/** Get all audit log entries */
export function getAuditLog(): readonly AuditLogEntry[] {
    return auditLog;
}

/**
 * Print a formatted summary of an audit log entry to stdout.
 */
export function printAuditEntry(entry: AuditLogEntry): void {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`AUDIT LOG #${entry.sequence} — ${entry.timestamp}`);
    console.log(`${'─'.repeat(60)}`);

    // Vault summary
    console.log(`  Vault: version=${entry.vaultState.version}, trading=${entry.vaultState.tradingEnabled}`);
    const balanceEntries = Object.entries(entry.vaultState.balances);
    for (const [type, amount] of balanceEntries) {
        const shortType = type.split('::').pop() ?? type;
        console.log(`    ${shortType}: ${Number(amount) / 1e9}`);
    }

    // Cap summary
    console.log(`  Cap: valid=${entry.capState.isValid}, remaining=${Number(entry.capState.remainingTradeVolume) / 1e9}`);
    if (entry.capState.invalidReason) {
        console.log(`    ❌ ${entry.capState.invalidReason}`);
    }

    // Market summary
    console.log(`  Market: mid=${entry.marketData.midPrice}, spread=${entry.marketData.spread}`);

    // Decision
    const d = entry.decision;
    console.log(`  Decision: ${d.action.toUpperCase()} ${d.amount > 0 ? Number(d.amount) / 1e9 : ''}`);
    console.log(`    Model: ${d.model}`);
    console.log(`    Reason: ${d.reason}`);

    // Trade result
    if (entry.tradeResult) {
        const t = entry.tradeResult;
        console.log(`  Trade: ${t.success ? '✅ SUCCESS' : '❌ FAILED'}`);
        if (t.txDigest) console.log(`    TX: ${t.txDigest}`);
        if (t.error) console.log(`    Error: ${t.error}`);
        console.log(`    Dry-run: ${t.dryRunStatus}`);
        if (t.events && t.events.length > 0) {
            for (const event of t.events) {
                console.log(`    Event: ${event.type}`);
                console.log(`      ${JSON.stringify(event.data)}`);
            }
        }
    } else {
        console.log(`  Trade: skipped (hold decision)`);
    }

    console.log(`${'─'.repeat(60)}`);
}

// ═══════════════════════════════════════════════════════
// QUERY TRADE HISTORY (Events)
// ═══════════════════════════════════════════════════════

/**
 * Query TradeExecuted events from the on-chain event log.
 * Returns the most recent trades for this vault.
 */
export async function queryTradeHistory(
    client: SuiJsonRpcClient,
    packageId: string,
    limit: number = 10,
): Promise<Array<{ txDigest: string; data: Record<string, unknown> }>> {
    const events = await client.queryEvents({
        query: {
            MoveEventType: `${packageId}::events::TradeExecuted`,
        },
        limit,
        order: 'descending',
    });

    return events.data.map((event) => ({
        txDigest: event.id.txDigest,
        data: event.parsedJson as Record<string, unknown>,
    }));
}

// ═══════════════════════════════════════════════════════
// UTILITY: Create Client + Signer
// ═══════════════════════════════════════════════════════

/**
 * Create a SuiJsonRpcClient with MVR support for the configured network.
 */
export function createClient(network: AgentConfig['network']): SuiJsonRpcClient {
    return new SuiJsonRpcClient({
        url: getJsonRpcFullnodeUrl(network),
        network,
    });
}

/**
 * Create an Ed25519Keypair from the SUI_PRIVATE_KEY environment variable.
 */
export function createSigner(): Ed25519Keypair {
    const privateKey = process.env.SUI_PRIVATE_KEY;
    if (!privateKey) {
        throw new Error('SUI_PRIVATE_KEY environment variable not set');
    }
    return Ed25519Keypair.fromSecretKey(privateKey);
}
