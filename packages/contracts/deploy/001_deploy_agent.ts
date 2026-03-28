import type { DeployFunction } from "hardhat-deploy/types";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

function isLocalNetwork(name: string) {
  return name === "hardhat" || name === "localhost";
}

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, log } = hre.deployments;
  const networkName = hre.network.name;

  log("──────────────────────────────────────────");
  log(`Deploying AnomalyAgent to ${networkName}...`);

  // On local networks the deployer is also the initial owner + watcher.
  // On Sepolia, set AGENT_OWNER in .env to use a separate owner address.
  const initialOwner =
    isLocalNetwork(networkName)
      ? deployer
      : (process.env.AGENT_OWNER ?? deployer);

  const anomalyAgent = await deploy("AnomalyAgent", {
    from: deployer,
    args: [initialOwner],
    log: true,
    autoMine: true,
  });

  log(`✅ AnomalyAgent deployed at: ${anomalyAgent.address}`);

  // On local networks, register the deployer as a watcher automatically
  // so the demo can submit scores without extra setup.
  if (isLocalNetwork(networkName)) {
    const { ethers } = hre;
    const signer = await ethers.getSigner(deployer);
    const agent = await ethers.getContractAt("AnomalyAgent", anomalyAgent.address, signer);

    const alreadyWatcher = await agent.isWatcher(deployer);
    if (!alreadyWatcher) {
      log(`Registering deployer as watcher: ${deployer}`);
      const tx = await agent.addWatcher(deployer);
      await tx.wait();
      log("✅ Deployer registered as watcher");
    }
  }

  log("──────────────────────────────────────────");
};

export default func;
func.id = "deploy_anomaly_agent";
func.tags = ["AnomalyAgent"];