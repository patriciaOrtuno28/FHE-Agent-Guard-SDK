# FHE Agent Guard — Production Checklist

Everything required to turn this demo into a real, production-grade platform.
Items are ordered roughly by dependency: later items generally require earlier ones.

---

## 11. Monitoring & Observability

**What needs to happen:**
- Add structured logging to the inference server (timestamps, subject hash, prediction, latency).
- Add error tracking to the Next.js app (Sentry or similar) for both server and client.
- Set up uptime monitoring for the inference server endpoint.
- Emit on-chain events from `AnomalyAgent` are already in place (`ScoreSubmitted`, `AnomalyHandled`) — set up a subgraph or event indexer to query historical anomaly detections.

---

## 12. Vercel Deployment

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

## 13. Malicious testing

**Current state:** The webpage has only been tested with trusted wallets.

**What needs to happen:**
- Simulate a malicious wallet.
- Try to connect it and see how it does not get access granted.
