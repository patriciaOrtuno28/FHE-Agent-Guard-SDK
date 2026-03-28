# FHE Agent Guard SDK

Confidential anomaly detection for on-chain agents, built on [Zama's fhEVM](https://github.com/zama-ai/fhevm) and [Concrete ML](https://github.com/zama-ai/concrete-ml).

Detects fraudulent or anomalous transaction patterns without any plaintext data leaving the client — features are encrypted before analysis, the ML model runs on ciphertext, and only the anomaly label (normal / anomaly) is returned.

---

## What's in this repo

```
packages/
├── contracts/          Solidity — AnomalyAgent.sol receives encrypted scores on-chain
├── sdk/                TypeScript — AgentGuard, FhEVMConnector, types
├── models/             Python — trains and compiles the RandomForest FHE model via Docker
└── inference-server/   Python — FastAPI server that loads the model and serves /predict
apps/
└── demo/               DeFi fraud detection demo using the SDK
```

The SDK fetches 8 on-chain features (tx value, frequency, gas price, etc.) via `FhEVMConnector`, normalizes them, sends them to the inference server, and fires `onAnomaly` if the model flags the transaction pattern as suspicious.

---

## Requirements

- Node.js 20+ and pnpm
- Docker Desktop (running)

---

## Setup

```bash
# Install JS dependencies
pnpm install

# Run SDK tests
pnpm test
```

---

## Compile the FHE model

This trains a `RandomForestClassifier` on synthetic DeFi transaction data (normal vs anomalous) and serializes it via Concrete ML. Only needed once — output goes to `packages/models/artifacts/`.

```bash
pnpm models:build       # build Docker image (~3 min)
pnpm models:dry-run     # verify environment (fast)
pnpm models:compile     # compile FHE model (~10 min)
```

---

## Run the inference server

The server loads `anomaly_model.json`, recompiles the FHE circuit, and exposes `POST /predict`.

```bash
pnpm inference:build    # build Docker image (~3 min)
pnpm inference:start    # start on http://localhost:8000
```

Verify it's running:
```bash
curl http://localhost:8000/health
# {"status":"ok","model":"base-anomaly-rf-v1","fhe_mode":"simulate"}
```

---

## Deploy contracts and run the demo

```bash
# Copy env file and fill in your keys
cp .env.example .env

# Start local Hardhat node
pnpm chain

# Deploy AnomalyAgent.sol
pnpm deploy:local

# Export contract addresses into the SDK
pnpm contracts:export

# Run the DeFi fraud detection demo
pnpm demo
```

---

## Deploy to Sepolia

```bash
pnpm deploy:sepolia
pnpm contracts:export:sepolia
```

---

## How a check works

```
FhEVMConnector
  → fetches 8 tx features from the chain (ethers.js v6)
  → POST /predict to inference server
  → RandomForestClassifier runs in FHE simulation
  → returns { label: "normal" | "anomaly" }
  → fires onAnomaly handler if flagged
  → handler can call AnomalyAgent.sol to pause / alert on-chain
```

Built for [Zama Bounty Track — Mainnet Season 2](https://www.zama.ai/developer-programs).