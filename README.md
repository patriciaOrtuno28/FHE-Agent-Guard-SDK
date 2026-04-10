<div align="center">

<br/>

<img src="https://img.shields.io/badge/FHE%20Agent%20Guard-7C3AED?style=for-the-badge&labelColor=000000&logoColor=7C3AED" height="60" alt="FHE Agent Guard"/>

<br/><br/>

# Confidential On-Chain Risk Scanning with FHE

### *Detect suspicious wallet behavior without exposing raw features or plaintext scores.*

<br/>

[![Built with fhEVM](https://img.shields.io/badge/Built%20with-fhEVM-7C3AED?style=flat-square&labelColor=000000)](https://www.zama.ai/)
[![Model](https://img.shields.io/badge/Model-Concrete%20ML-7C3AED?style=flat-square&labelColor=000000)]()
[![Network](https://img.shields.io/badge/Network-Sepolia-7C3AED?style=flat-square&labelColor=000000)]()
[![Mainnet](https://img.shields.io/badge/Mainnet-Coming%20Soon-F59E0B?style=flat-square&labelColor=000000)]()
[![Stack](https://img.shields.io/badge/Stack-Next.js%20%7C%20Hardhat%20%7C%20FastAPI-7C3AED?style=flat-square&labelColor=000000)]()
[![License](https://img.shields.io/badge/License-BSD--3--Clause--Clear-7C3AED?style=flat-square&labelColor=000000)]()

<br/>

---

<table width="100%">
<tr>
<td width="100%" valign="top" align="center">

**📖 &nbsp;Project**

[Overview](#-overview) &nbsp;·&nbsp; [Why it matters](#-why-it-matters) &nbsp;·&nbsp; [Architecture](#-architecture) &nbsp;·&nbsp; [How the flow works](#-how-the-flow-works) &nbsp;·&nbsp; [Repository structure](#-repository-structure)

</td>
</tr>
<tr>
<td width="100%" valign="top" align="center">

**🛠️ &nbsp;Build and run**

[Prerequisites](#-prerequisites) &nbsp;·&nbsp; [Environment](#-environment) &nbsp;·&nbsp; [Local setup](#-local-setup) &nbsp;·&nbsp; [Sepolia deployment](#-sepolia-deployment)

</td>
</tr>
</table>

---

</div>

<br/>

<video src="docs/FHETrustScoreAgent.mp4" autoplay loop muted playsinline width="100%" controls>
  Your browser does not support the video tag.
</video>

<br/>

## 🔍 Overview

**FHE Agent Guard** is a confidential anomaly-detection system for on-chain activity — packaged as a **drop-in Next.js plugin** that any platform can embed in its login flow.

It scans wallet behavior, derives a set of transaction features, sends them to a **Concrete ML** inference service, encrypts the resulting trust score using **Zama's relayer SDK**, and allows the wallet owner to decrypt the result later through **MetaMask + KMS authorization**.

The plugin exposes a configurable score threshold (0–10). Any score equal to or above the threshold grants access; below it, access is denied — all without ever putting plaintext scores or sensitive intermediate data on-chain.

> **Detect risky wallet behavior without exposing raw features or plaintext scores.**

<br/>

## ⚡ Why it matters

Most risk engines and fraud tools rely on off-chain scoring and plaintext data pipelines. That makes them hard to verify, hard to integrate with smart contracts, and easy to overexpose.

**FHE Agent Guard** keeps the result confidential while still making it usable on-chain:

- **Client-side submission** of encrypted trust scores
- **On-chain storage** of FHE-protected values
- **User-scoped ACL permissions** for decryption
- **MetaMask-based authorization** for decrypting the score
- **Configurable threshold** — platform operators set the minimum score (0–10) required for access
- **Sepolia-first architecture**, with Mainnet reserved for a later rollout

<br/>

## 🏛️ Architecture

<div align="center">
  <img src="./docs/fhe_agent_guard_architecture.png" alt="FHE Agent Guard architecture" width="100%" />
</div>

<div align="center">
  <img src="./docs/flow_diagram.png" alt="Full architecture flow diagram" width="100%" />
</div>

<br/>

The repository is organized as a three-layer stack:

```
@fhe-guard/sdk  (Node.js scan engine — AgentGuard, FhEVMConnector)
      ↓
@fhe-guard/plugin  (npm package — React components, hooks, Next.js route factories)
      ↓
apps/trading-demo  (consumer demo — trading website with FHE-gated login)
```

<br/>

## 🔄 How the flow works

1. The user visits the trading platform and sees the **minimum trust score required** (e.g. 7/10).
2. They sign in with their username and **Ethereum wallet address**.
3. The platform runs an **FHE scan**: wallet on-chain activity is collected, features are derived, and the feature vector is sent to the **inference API**.
4. The model returns a trust score / label.
5. The frontend encrypts the score with the **Zama relayer SDK** (KMS public key).
6. The encrypted handle and proof are submitted to **`AnomalyAgent.sol`** on-chain.
7. The contract stores the encrypted score and grants the right ACL permissions.
8. The score is compared against the configured threshold: **≥ threshold → access granted**, **< threshold → access denied**.
9. When the user clicks **Decrypt My Score**, MetaMask signs the EIP-712 payload.
10. The KMS verifies permissions and returns the plaintext score to the frontend.

<br/>

## 🧩 Repository structure

```text
apps/
└── trading-demo/          Next.js trading platform — demo consumer of @fhe-guard/plugin
                           Pages: / · /login · /register · /verify · /dashboard

packages/
├── plugin/                @fhe-guard/plugin — the publishable npm package
│                          Exports: FheGuardProvider, FheGuardGate, useFheGuard,
│                                   createFheGuardHandler, createRelayerHandler
├── contracts/             Hardhat project and AnomalyAgent contract
├── sdk/                   TypeScript SDK — AgentGuard core engine and FHE helpers
├── models/                Concrete ML training / compilation pipeline
└── inference-server/      FastAPI inference server
```

<br/>

## 🚀 Deployment

| Component | Where it runs | Notes |
|---|---|---|
| `apps/trading-demo` | **Vercel** | Frontend + Next.js API routes |
| `packages/inference-server` | **Render** | FastAPI + Concrete ML inference |
| `AnomalyAgent.sol` | **Sepolia** | On-chain encrypted score storage |
| RPC access | **Alchemy / Infura** | Blockchain reads and transaction broadcast |
| Wallet | **MetaMask** | Runs on the user device |
| Relayer / KMS | **Zama network services** | FHE encryption and authorized decryption |

<br/>

## 🛠️ Prerequisites
- Node.js 20+
- pnpm
- Docker Desktop
- MetaMask
- Sepolia ETH for contract interaction

<br/>

## 🔧 Environment

Create these files before running the project.

1. Root `.env` based on root `.env.example`
2. `apps/trading-demo/.env.local` based on `apps/trading-demo/.env.example`
3. `packages/contracts/.env` based on `.env.example` in that same path

Key variables in `apps/trading-demo/.env.local`:

```bash
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v3/YOUR_KEY
INFERENCE_URL=http://localhost:8000
INFERENCE_API_KEY=your-key
NEXT_PUBLIC_TRUST_SCORE_AGENT_SEPOLIA=0x<deployed-contract-address>
NEXT_PUBLIC_REQUIRED_SCORE=7          # admin-configured threshold (0–10)
```

<br/>

## 🚀 Local setup

Install dependencies:
```bash
pnpm install
```

(Optional) Create a real dataset if not available:
```bash
python packages/models/scripts/build_real_test_data.py --output packages/models/data/test_data.csv --verbose
```

Build and compile the ML model for the inference server:
```bash
pnpm models:build
pnpm models:compile -- --dataset /app/data/test_data.csv
```

Build and start the inference server:
```bash
pnpm inference:build
pnpm inference:start
```

Compile and deploy the contract:
```bash
pnpm --filter @fhe-guard/contracts compile
pnpm deploy:sepolia
pnpm contracts:export:sepolia
```

Build the plugin:
```bash
pnpm plugin:build
```

Run the trading demo:
```bash
pnpm trading-demo
```

Open `http://localhost:3001`

<br/>

## 🌐 Sepolia deployment

The current supported network is:

- Sepolia ✅
- Ethereum Mainnet 🚧 Coming Soon

After deploying to Sepolia, update `NEXT_PUBLIC_TRUST_SCORE_AGENT_SEPOLIA=0x...` in `apps/trading-demo/.env.local`. Then restart the app.

<br/>

## 📦 Using `@fhe-guard/plugin`

The plugin is the core product. Any Next.js application can install it and add FHE trust score gating to its login flow.

**1. Wrap your app with the provider** (sets the threshold and network):

```tsx
// app/layout.tsx
import { FheGuardProvider } from '@fhe-guard/plugin';

export default function Layout({ children }) {
  return (
    <FheGuardProvider threshold={7} network="sepolia">
      {children}
    </FheGuardProvider>
  );
}
```

**2. Add the server-side scan route** (thin wrapper in your API routes):

```ts
// app/api/scan/route.ts
import { createFheGuardHandler } from '@fhe-guard/plugin/server';

export const runtime = 'nodejs';
export const POST = createFheGuardHandler({
  getRpcUrl:        (n) => process.env[`${n.toUpperCase()}_RPC_URL`],
  getExplorerApiUrl: () => undefined,
  inferenceUrl:     process.env.INFERENCE_URL!,
  inferenceApiKey:  process.env.INFERENCE_API_KEY,
});
```

**3. Use the hook in your login flow**:

```tsx
'use client';
import { useFheGuard } from '@fhe-guard/plugin';

export function TrustCheck({ walletAddress }) {
  const { scan, status, score, isAllowed, threshold } = useFheGuard();

  return (
    <div>
      <p>Required score: {threshold}/10</p>
      <button onClick={() => scan(walletAddress)}>Verify</button>
      {status === 'complete' && (
        <p>{isAllowed ? `Access granted (${score}/10)` : `Access denied (${score}/10)`}</p>
      )}
    </div>
  );
}
```

<br/>

## 🧪 Typical user flow

1. Visit the platform — see the **minimum trust score required** prominently displayed
2. Register or sign in with a username and Ethereum wallet address
3. The platform runs the **FHE scan** automatically on the `/verify` page
4. Progress is shown step-by-step (connecting → fetching → encrypting → inferring → complete)
5. **Score ≥ threshold** → redirected to the trading dashboard
6. **Score < threshold** → access denied with explanation
7. On the dashboard: view portfolio, trade assets, see trust score badge in the navbar
