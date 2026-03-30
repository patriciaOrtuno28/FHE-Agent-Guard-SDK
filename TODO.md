# FHE Agent Guard — Production Checklist

Everything required to turn this demo into a real, production-grade platform.
Items are ordered roughly by dependency: later items generally require earlier ones.

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
