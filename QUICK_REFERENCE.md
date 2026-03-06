# Quick Reference Commands

## Deployed Testnet IDs

```bash
export PACKAGE_ID=0xa249bf144da12ebdb2e2bb672531cd4be0cbd671110761b07828b515609ef268
export VAULT_ID=0xf4b642394cc4597e2bfaa73c12dc162d8da9e40fe3fc6bb8b56a251872ca6cb2
export OWNER_CAP_ID=0x3f3cb57afd319bafdb6dd678ba79b704091db6bfd15c0b90a1c7fd08c7a42ba0
export CAP_ID=0x81c73d0b1f3251b41bd53be16e50309e47b15fd7ab0c8fa4a363f7c624a2ab19
export OWNER_ADDRESS=0x269abaa2ef26b6bda404dd6e891102f1392280d79a8f589bc829a213e7b4cb67
```

---

## 1. Move (On-Chain)

### Build
```bash
sui move build
```

### Test (27/27 pass)
```bash
sui move test
sui move test --verbose
sui move test --filter negative_tests
```

### Publish (already done)
```bash
sui client publish --gas-budget 100000000
```

---

## 2. TypeScript Scripts

### Setup
```bash
cd scripts
npm install
```

### Deploy a new vault (publish + create + deposit)
```bash
export SUI_PRIVATE_KEY="suiprivkey1..."
npx tsx deploy.ts
```

### Manage vault (mint cap, revoke, toggle trading)
```bash
export SUI_PRIVATE_KEY="suiprivkey1..."
export PACKAGE_ID="0x..."
export VAULT_ID="0x..."
export OWNER_CAP_ID="0x..."
npx tsx manage_vault.ts
```

### Execute trade demo (PTB construction)
```bash
export SUI_PRIVATE_KEY="suiprivkey1..."
export PACKAGE_ID="0x..."
export VAULT_ID="0x..."
export CAP_ID="0x..."
npx tsx execute_trade.ts
```

---

## 3. AI Agent

### Run agent (dry-run mode — safe, no real trades)
```bash
cd scripts
npx tsx --env-file=.env run_agent.ts
```

### Run agent (live trading)
```bash
EXECUTE_REAL_TRADES=true npx tsx --env-file=.env run_agent.ts
```

### Or use npm scripts
```bash
npm run agent           # dry-run
npm run agent:live      # live trading
```

### Environment file
```bash
cp .env.example .env    # then edit .env with your values
```

---

## 4. Sui CLI Commands

### Check vault state
```bash
sui client object $VAULT_ID
```

### Check vault balances (dynamic fields)
```bash
sui client dynamic-field $VAULT_ID
```

### Check cap state
```bash
sui client object $CAP_ID
```

### Check your balance
```bash
sui client gas
```

### Get testnet SUI
Visit: https://faucet.sui.io/?address=$OWNER_ADDRESS

### Mint a new DelegatedTradingCap
```bash
sui client call \
  --package $PACKAGE_ID --module capabilities --function mint_delegated_trading_cap \
  --args $VAULT_ID $OWNER_CAP_ID $OWNER_ADDRESS 1130 5000000000 1000000000 \
  --gas-budget 50000000
```

### Revoke all delegations (O(1) version bump)
```bash
sui client call \
  --package $PACKAGE_ID --module vault --function revoke_all_delegations \
  --args $VAULT_ID $OWNER_CAP_ID \
  --gas-budget 50000000
```

### Toggle trading on/off
```bash
# Disable
sui client call \
  --package $PACKAGE_ID --module vault --function set_trading_enabled \
  --args $VAULT_ID $OWNER_CAP_ID false \
  --gas-budget 50000000

# Enable
sui client call \
  --package $PACKAGE_ID --module vault --function set_trading_enabled \
  --args $VAULT_ID $OWNER_CAP_ID true \
  --gas-budget 50000000
```

### Deposit SUI into vault
```bash
sui client ptb \
  --split-coins gas "[500000000]" \
  --assign coin \
  --move-call "${PACKAGE_ID}::vault::deposit<0x2::sui::SUI>" \
    @$VAULT_ID @$OWNER_CAP_ID coin \
  --gas-budget 50000000
```

### Swap SUI for DEEP on DeepBook (testnet)
```bash
sui client ptb \
  --split-coins gas "[500000000]" \
  --assign sui_coin \
  --move-call "0x2::coin::zero<0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP>" \
  --assign deep_zero \
  --move-call "0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c::pool::swap_exact_quote_for_base<0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP, 0x2::sui::SUI>" \
    @0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f \
    sui_coin deep_zero 0 @0x6 \
  --assign result \
  --transfer-objects "[result.0, result.1, result.2]" @$OWNER_ADDRESS \
  --gas-budget 100000000
```

### Deposit DEEP into vault
```bash
sui client call \
  --package $PACKAGE_ID --module vault --function deposit \
  --type-args 0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP \
  --args $VAULT_ID $OWNER_CAP_ID <DEEP_COIN_OBJECT_ID> \
  --gas-budget 50000000
```

---

## 5. DeepBook V3 Testnet Pools

| Pool | ID | Base | Quote | Fees |
|------|---|------|-------|------|
| DEEP/SUI | `0x48c959...` | DEEP | SUI | 0% (whitelisted) |
| SUI/DBUSDC | `0x1c1936...` | SUI | DBUSDC | standard |
| DEEP/DBUSDC | `0xe86b99...` | DEEP | DBUSDC | standard |

### Token Types
```
SUI:    0x2::sui::SUI
DEEP:   0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP
DBUSDC: 0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC
```

---

## 6. Useful Explorer Links

- **Package:** https://suiscan.xyz/testnet/object/0xa249bf144da12ebdb2e2bb672531cd4be0cbd671110761b07828b515609ef268
- **Vault:** https://suiscan.xyz/testnet/object/0xf4b642394cc4597e2bfaa73c12dc162d8da9e40fe3fc6bb8b56a251872ca6cb2
- **Faucet:** https://faucet.sui.io/?address=0x269abaa2ef26b6bda404dd6e891102f1392280d79a8f589bc829a213e7b4cb67
