/**
 * DeFi Fraud Detection Demo
 * ─────────────────────────
 * Shows FHE Agent Guard detecting anomalous on-chain behaviour
 * without any plaintext data leaving the client.
 *
 * Run: pnpm demo
 *   or: cd apps/demo && pnpm dev
 */

import { AgentGuard, FhEVMConnector, ModelRegistry, sdkByChainId } from "@fhe-guard/sdk";

const RPC_URL        = process.env["RPC_URL"]        ?? "http://localhost:8545";
const CONTRACT_ADDR  = (process.env["CONTRACT_ADDR"] ?? "0x5FbDB2315678afecb367f032d93F642f64180aa3") as `0x${string}`;
const TARGET_ADDRESS = process.env["TARGET_ADDRESS"] ?? "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

async function main() {
  console.log("🛡  FHE Agent Guard — DeFi Fraud Demo");
  console.log("━".repeat(50));
  console.log("All features encrypted before analysis.");
  console.log("No plaintext data leaves the client.\n");

  // Show deployed contract info for the current chain
  const chain = sdkByChainId[31337];
  console.log(`📋 Chain:     localhost (${chain.chainId})`);
  console.log(`📦 Models:    ${ModelRegistry.list().join(", ")}\n`);

  // Set up connector
  const fhevmConnector = new FhEVMConnector({
    rpcUrl: RPC_URL,
    tokenAddress: CONTRACT_ADDR,
    blockRange: 256,
  });

  // Instantiate guard
  const guard = new AgentGuard({
    rpcUrl: RPC_URL,
    model: {
      kind: "random-forest",
      artifact: "base",
      threshold: 7,
    },
    connectors: [fhevmConnector],
    contractAddress: CONTRACT_ADDR,
    onAnomaly: async (ctx) => {
      console.log("\n🚨 ANOMALY DETECTED");
      console.log(`   Subject:  ${ctx.subject}`);
      console.log(`   Label:    ${ctx.result.label}`);
      console.log(`   Score:    [encrypted — handle: ${ctx.result.encryptedScore}]`);
      console.log(`   Action:   Flagging address on-chain\n`);

      // In production with a deployed contract:
      // const provider = new ethers.JsonRpcProvider(RPC_URL)
      // const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider)
      // const agent = AnomalyAgent__factory.connect(ctx.contractAddress!, signer)
      // await agent.submitScore(ctx.subject, ctx.result.encryptedScore, proof)
    },
    pollIntervalMs: 12_000,
  });

  // Subscribe to events
  guard.onEvent((ev) => {
    switch (ev.type) {
      case "watch_tick":
        console.log(`\n⏱  ${new Date(ev.tickAt).toISOString()} — checking ${ev.subject}`);
        break;
      case "fetch_done":
        console.log(`  ✓ [${ev.connectorId}] fetched in ${ev.durationMs}ms`);
        break;
      case "fetch_error":
        console.error(`  ✗ [${ev.connectorId}] ${ev.error.message}`);
        break;
      case "encrypt_done":
        console.log(`  🔒 Encrypted in ${ev.durationMs}ms`);
        break;
      case "predict_done":
        console.log(`  🤖 Predicted: ${ev.label} (${ev.durationMs}ms)`);
        break;
    }
  });

  // Health checks
  console.log("🏥 Health checks:");
  const health = await guard.healthCheck();
  for (const [id, ok] of Object.entries(health)) {
    console.log(`   ${ok ? "✓" : "✗"} ${id}`);
  }
  console.log();

  // One-shot check
  console.log(`🔍 Checking ${TARGET_ADDRESS}...\n`);
  await guard.run(TARGET_ADDRESS);

  // Uncomment to start continuous watch loop:
  // const stop = guard.watch(TARGET_ADDRESS)
  // process.on("SIGINT", () => { stop(); process.exit(0) })
}

main().catch(console.error);