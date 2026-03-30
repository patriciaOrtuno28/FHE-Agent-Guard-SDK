# FHE Agent Guard — Production Checklist

Everything required to turn this demo into a real, production-grade platform.
Items are ordered roughly by dependency: later items generally require earlier ones.

---

## 4. Wire On-Chain Score Submission

**Current state:** The `onAnomaly` callback in `AgentGuard` logs the anomaly but does **not** call the smart contract. The comment in `apps/demo/src/defi-fraud.ts` shows the intended ethers.js call but it is commented out.

**What needs to happen:**
- In the scan route (`apps/demo/src/app/api/scan/route.ts`), implement `onAnomaly` to call `AnomalyAgent.submitScore(subject, encryptedHandle, inputProof)` using ethers.js and a server-side signer (private key from env).
- The `encryptedHandle` must be a real FHE ciphertext handle (see item 2) — the current mock handle will be rejected by the contract's `FHE.fromExternal()` verification.
- Add `SUBMITTER_PRIVATE_KEY` to `.env.local` (server-side only, never client).
- Add the submitter address as a watcher via `AnomalyAgent.addWatcher(submitterAddress)` after deployment.

---

## 5. On-Chain Decryption (Decrypt My Score button)

**Current state:** `apps/demo/src/lib/fhe.ts › decryptAnomalyScore()` is fully wired. The UI shows the button when on Sepolia with a known contract address. But it will fail because:
1. The contract is not deployed on Sepolia (item 3).
2. The encrypted score handle is a mock, not a real FHE ciphertext (item 2).
3. `FHE.allow(isAnomaly, owner())` is called in the contract but the user's address is not `allow()`'d — the contract needs `FHE.allow(handle, userAddress)` so the KMS ACL permits decryption for that specific user.

**What needs to happen:**
- Complete items 2, 3, and 4 first.
- In `AnomalyAgent.sol › submitScore()`, add `FHE.allow(isAnomaly, subject)` so the subject wallet can decrypt their own score.
- Re-deploy and re-export.
- The existing `decryptAnomalyScore()` flow in `fhe.ts` will then work end-to-end: MetaMask signs EIP-712 → Zama KMS verifies ACL → returns plaintext score.

---

## 6. Replace the Public RPC URLs with Private Ones

**Current state:** `.env.local` uses public RPCs (`sepolia.drpc.org`, `eth.llamarpc.com`) which are rate-limited and unreliable under any real load.

**What needs to happen:**
- Provision Alchemy or Infura project keys.
- Set `SEPOLIA_RPC_URL` and `MAINNET_RPC_URL` to the private endpoints in `.env.local` (local) and Vercel environment variables (production).
- Never commit these keys — `.env.local` is already in `.gitignore`.

---

## 7. Inference Server: Real FHE Inference + Authentication

**Current state:** The inference server (`packages/inference-server/`) runs a plaintext sklearn model. It has no authentication — anyone who can reach it can request predictions.

**What needs to happen:**
- Load the compiled FHE circuit from mounted artifacts (see item 1).
- Replace `model.predict()` with actual FHE encrypted inference.
- Add an API key check: the Next.js scan route sends `Authorization: Bearer $INFERENCE_API_KEY`; the inference server validates it.
- Add `INFERENCE_API_KEY` to both `.env.local` and the inference server's environment in `docker-compose.yml`.
- Rate-limit the `/predict` endpoint per IP or API key.

---

## 8. Training Data: Replace Synthetic Data with Real Data

**Current state:** `packages/models/scripts/compile_random_forest.py` generates fully synthetic training data with hardcoded anomaly patterns. The model has never seen real on-chain behavior.

**What needs to happen:**
- Collect a labelled dataset of real Ethereum transactions (normal + known-anomalous addresses).
- Sources: Etherscan labels, community-maintained lists (e.g. Forta, Chainalysis public feeds), historical exploit addresses.
- Retrain the model and re-compile the FHE circuit.
- Track model version in the artifact manifest alongside a data provenance note.
- Establish a retraining cadence as new attack patterns emerge.

---

## 9. Vercel Deployment

**Current state:** The Next.js app runs locally. It has not been deployed.

**What needs to happen:**
- Push the repo to GitHub.
- Connect the repo to Vercel. Set root directory to `apps/demo`.
- Add all environment variables in the Vercel dashboard:
  - `SEPOLIA_RPC_URL`
  - `MAINNET_RPC_URL`
  - `INFERENCE_URL` (must be a publicly reachable URL, not localhost)
  - `INFERENCE_API_KEY`
- The inference server must be deployed somewhere reachable (e.g. Railway, Fly.io, or a VPS) before Vercel can call it.
- Verify `maxDuration = 30` in the scan route is within Vercel's plan limits (Pro = 300s, Hobby = 10s).

---

## 10. Security Hardening

**Current state:** Basic server-side validation exists but several attack surfaces remain open.

**What needs to happen:**
- **Rate limiting on `/api/scan`:** Each scan triggers multiple RPC calls and an inference request. Add per-IP rate limiting (e.g. `@upstash/ratelimit` with Redis on Vercel, or a simple in-memory limiter for self-hosted).
- **CORS:** Restrict `Access-Control-Allow-Origin` in API routes to your own domain.
- **Content-Security-Policy header:** Add a strict CSP in `next.config.mjs` to block XSS vectors, especially since the app loads a WASM bundle from `@zama-fhe/relayer-sdk`.
- **Submitter key isolation:** The private key that calls `submitScore` on-chain should be a dedicated hot wallet with minimal ETH, not the deployer key.
- **Contract access control review:** Audit who can call `addWatcher`, `removeWatcher`, `setThreshold`, `pause`. Currently only `owner()` — confirm the owner is a multisig, not an EOA, before mainnet.

---

## 11. Monitoring & Observability

**What needs to happen:**
- Add structured logging to the inference server (timestamps, subject hash, prediction, latency).
- Add error tracking to the Next.js app (Sentry or similar) for both server and client.
- Set up uptime monitoring for the inference server endpoint.
- Emit on-chain events from `AnomalyAgent` are already in place (`ScoreSubmitted`, `AnomalyHandled`) — set up a subgraph or event indexer to query historical anomaly detections.

---

## Summary: Minimum Viable Production Path

```
Item 4  Deploy AnomalyAgent + wire score submission ← most critical next step
Item 6  Private RPC URLs
Item 7  Inference server auth + rate limiting
Item 9  Deploy to Vercel + hosted inference
```

Items 5 (decrypt button), 8 (real training data), 10 (hardening), and 11 (monitoring)
follow naturally once the core pipeline is real.
