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
<tr>
<td width="100%" valign="top" align="center">

**🏪 &nbsp;Merchant integration**

[Quickstart](#-merchant-integration-guide) &nbsp;·&nbsp; [Install](#1-install-the-plugin) &nbsp;·&nbsp; [API route](#2-add-the-scan-api-route) &nbsp;·&nbsp; [Provider](#3-wrap-your-app-with-the-provider) &nbsp;·&nbsp; [Login page](#4-add-trust-check-to-your-login-page) &nbsp;·&nbsp; [Gate pages](#5-gate-protected-pages)

</td>
</tr>
<tr>
<td width="100%" valign="top" align="center">

**🧪 &nbsp;Testing**

[Run tests](#-testing) &nbsp;·&nbsp; [Test files](#test-files) &nbsp;·&nbsp; [Malicious wallet simulation](#malicious-wallet-simulation)

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

---

<details>
<summary><h2>🚀 Local setup</h2></summary>

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

</details>

---

<details>
<summary><h2>🌐 Sepolia deployment</h2></summary>

The current supported network is:

- Sepolia ✅
- Ethereum Mainnet 🚧 Coming Soon

After deploying to Sepolia, update `NEXT_PUBLIC_TRUST_SCORE_AGENT_SEPOLIA=0x...` in `apps/trading-demo/.env.local`. Then restart the app.

</details>

---

<br/>

## 🏪 Merchant Integration Guide

This section explains how to add **FHE Agent Guard** to the login or registration flow of your own Next.js application. The plugin handles wallet scanning, scoring, and access gating — you only wire up a few files.

> The full working example is in [`apps/trading-demo`](apps/trading-demo).

<br/>

### 1. Install the plugin

```bash
npm install @fhe-guard/plugin
# or
pnpm add @fhe-guard/plugin
```

Set the following environment variables in your `.env.local`:

```bash
# Your blockchain RPC endpoint (Alchemy, Infura, etc.)
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v3/YOUR_KEY

# The inference server that scores wallets
INFERENCE_URL=https://your-inference-server.example.com
INFERENCE_API_KEY=your-secret-key

# Minimum score a wallet must achieve to gain access (0–10)
NEXT_PUBLIC_REQUIRED_SCORE=7
```

<br/>

### 2. Add the scan API route

Create a thin server-side handler in your Next.js API routes. This is the endpoint the plugin calls internally — you do not need to call it yourself.

```ts
// app/api/scan/route.ts
import { createFheGuardHandler } from '@fhe-guard/plugin/server';

export const runtime = 'nodejs';
export const maxDuration = 30;

export const POST = createFheGuardHandler({
  getRpcUrl:         (network) => process.env[`${network.toUpperCase()}_RPC_URL`],
  getExplorerApiUrl: () => undefined,
  inferenceUrl:      process.env.INFERENCE_URL!,
  inferenceApiKey:   process.env.INFERENCE_API_KEY,
});
```

<br/>

### 3. Wrap your app with the provider

Add `FheGuardProvider` at the root of your layout. It sets the threshold and network for every page.

```tsx
// app/layout.tsx
import { FheGuardProvider } from '@fhe-guard/plugin';

export default function Layout({ children }: { children: React.ReactNode }) {
  const threshold = Number(process.env.NEXT_PUBLIC_REQUIRED_SCORE ?? 7);

  return (
    <FheGuardProvider threshold={threshold} network="sepolia">
      {children}
    </FheGuardProvider>
  );
}
```

<br/>

### 4. Add trust check to your login page

Use the `useFheGuard` hook to trigger a scan when the user submits their wallet address. Show the result inline — the hook streams progress events so you can display a step-by-step status.

```tsx
'use client';
import { useFheGuard } from '@fhe-guard/plugin';

export function LoginForm() {
  const { scan, status, score, isAllowed, threshold } = useFheGuard();
  const [wallet, setWallet] = React.useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await scan(wallet);
  }

  return (
    <form onSubmit={handleSubmit}>
      <p>Minimum score required: {threshold}/10</p>

      <input
        value={wallet}
        onChange={(e) => setWallet(e.target.value)}
        placeholder="0x..."
      />
      <button type="submit" disabled={status === 'scanning'}>
        {status === 'scanning' ? 'Scanning…' : 'Verify wallet'}
      </button>

      {status === 'complete' && (
        isAllowed
          ? <p>✅ Access granted — score {score}/10</p>
          : <p>❌ Access denied — score {score}/10 (minimum {threshold})</p>
      )}
    </form>
  );
}
```

| `status` value | Meaning |
|---|---|
| `idle` | No scan started yet |
| `scanning` | Scan in progress (streaming events) |
| `complete` | Score ready — check `isAllowed` |
| `error` | Scan failed — check `errorMessage` |

<br/>

### 5. Gate protected pages

Wrap any page or component that requires a passing score with `FheGuardGate`. Users who have not passed the scan are automatically redirected.

```tsx
// app/dashboard/page.tsx
import { FheGuardGate } from '@fhe-guard/plugin';

export default function Dashboard() {
  return (
    <FheGuardGate redirectTo="/login">
      <YourDashboardContent />
    </FheGuardGate>
  );
}
```

`FheGuardGate` reads the cached scan result from the provider context. If no passing result is found it redirects to `redirectTo`.

<br/>

### Threshold configuration

The threshold can be set per-environment via the provider prop or the env variable:

```tsx
// Set in code (takes priority)
<FheGuardProvider threshold={8} network="sepolia">

// Or via environment variable (read by the provider default)
NEXT_PUBLIC_REQUIRED_SCORE=8
```

Scores range from **0** (fully anomalous) to **10** (fully trusted). A threshold of **7** is the recommended starting point for financial applications.

<br/>

---

<br/>

## 🧪 Testing

### Run tests

All tests live in `packages/sdk/src/test/` and use [Vitest](https://vitest.dev/). No inference server or RPC connection is needed — connectors and the inference API are mocked.

```bash
# From the repo root
cd packages/sdk
npm test
```

Expected output:

```
✓ src/test/AgentGuard.test.ts        (5 tests)
✓ src/test/MaliciousWallet.test.ts   (15 tests)
✓ src/test/FhEVMConnector.test.ts    (9 tests)

Test Files  3 passed (3)
      Tests  29 passed (29)
```

<br/>

### Test files

| File | What it covers |
|---|---|
| [`AgentGuard.test.ts`](packages/sdk/src/test/AgentGuard.test.ts) | Core pipeline: connector calls, event emission, watch loop, onAnomaly suppression for trusted wallets |
| [`FhEVMConnector.test.ts`](packages/sdk/src/test/FhEVMConnector.test.ts) | On-chain feature extraction: balance ratio clamping, 1h vs 24h tx windows, contract interaction flag, RPC health |
| [`MaliciousWallet.test.ts`](packages/sdk/src/test/MaliciousWallet.test.ts) | Malicious wallet simulation — see below |

<br/>

### Malicious wallet simulation

`MaliciousWallet.test.ts` verifies that the guard correctly **blocks** anomalous wallets and **allows** trusted ones. Three attack profiles are simulated by injecting crafted feature vectors into a mock connector:

| Profile | Key signals | Expected result |
|---|---|---|
| **Bot / spammer** | 487 tx/h · 3 821 tx/24h · 412 unique targets · last tx 3 s ago | `blocked` · `onAnomaly` called |
| **Large-value attacker** | 4 500 ETH transfer · 8 000 gwei gas · −97 % balance drain | `blocked` · `onAnomaly` called |
| **Flash-loan attacker** | Contract interaction · 5 000 gwei gas · −85 % balance drain | `blocked` · score = 0 |
| **Score boundary** | Score = 6 (one below threshold) | `blocked` |
| **Score boundary** | Score = 7 (exactly at threshold) | `trusted` · `onAnomaly` not called |
| **Trusted wallet** | Normal low-frequency activity | `trusted` · `onAnomaly` not called |

Each profile asserts:
- Correct `label` (`"blocked"` or `"trusted"`)
- `rawScore` relative to the threshold
- Whether `onAnomaly` was invoked
- Whether the `anomaly_action` event was emitted

<br/>

---

<br/>

## 🧪 Typical user flow

1. Visit the platform — see the **minimum trust score required** prominently displayed
2. Register or sign in with a username and Ethereum wallet address
3. The platform runs the **FHE scan** automatically on the `/verify` page
4. Progress is shown step-by-step (connecting → fetching → encrypting → inferring → complete)
5. **Score ≥ threshold** → redirected to the trading dashboard
6. **Score < threshold** → access denied with explanation
7. On the dashboard: view portfolio, trade assets, see trust score badge in the navbar
