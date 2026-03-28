import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
chai.use(chaiAsPromised);
export const expect = chai.expect;

import { ethers, fhevm } from "hardhat";

// ── Helpers ───────────────────────────────────────────────────

function getHandle(enc: any, i = 0) {
  const h = enc?.handles?.[i];
  if (!h) throw new Error(`Encrypted input missing handles[${i}]`);
  return h;
}

function getProof(enc: any) {
  const p = enc?.inputProof ?? enc?.proof;
  if (!p) throw new Error("Encrypted input missing inputProof/proof");
  return p;
}

async function deployAgent() {
  const [owner, watcher, subject, attacker] = await ethers.getSigners();

  const Agent = await ethers.getContractFactory("AnomalyAgent", owner);
  const agent = await Agent.deploy(owner.address);
  await agent.waitForDeployment();
  const agentAddr = await agent.getAddress();

  return { agent, agentAddr, owner, watcher, subject, attacker };
}

// ── Tests ─────────────────────────────────────────────────────

describe("AnomalyAgent", () => {

  describe("Deployment", () => {
    it("sets the deployer as owner", async () => {
      const { agent, owner } = await deployAgent();
      expect(await agent.owner()).to.equal(owner.address);
    });

    it("starts unpaused", async () => {
      const { agent } = await deployAgent();
      expect(await agent.paused()).to.be.false;
    });

    it("deployer is not a watcher by default", async () => {
      const { agent, owner } = await deployAgent();
      expect(await agent.watchers(owner.address)).to.be.false;
    });
  });

  describe("Watcher management", () => {
    it("owner can add a watcher", async () => {
      const { agent, watcher } = await deployAgent();
      await (await agent.addWatcher(watcher.address)).wait();
      expect(await agent.watchers(watcher.address)).to.be.true;
    });

    it("owner can remove a watcher", async () => {
      const { agent, watcher } = await deployAgent();
      await (await agent.addWatcher(watcher.address)).wait();
      await (await agent.removeWatcher(watcher.address)).wait();
      expect(await agent.watchers(watcher.address)).to.be.false;
    });

    it("non-owner cannot add a watcher", async () => {
      const { agent, attacker, watcher } = await deployAgent();
      await expect(
        agent.connect(attacker).addWatcher(watcher.address)
      ).to.be.revertedWithCustomError(agent, "OwnableUnauthorizedAccount");
    });

    it("reverts on zero address", async () => {
      const { agent } = await deployAgent();
      await expect(
        agent.addWatcher(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(agent, "ZeroAddress");
    });
  });

  describe("Pause / unpause", () => {
    it("owner can pause and unpause", async () => {
      const { agent } = await deployAgent();
      await (await agent.pause()).wait();
      expect(await agent.paused()).to.be.true;
      await (await agent.unpause()).wait();
      expect(await agent.paused()).to.be.false;
    });

    it("non-owner cannot pause", async () => {
      const { agent, attacker } = await deployAgent();
      await expect(
        agent.connect(attacker).pause()
      ).to.be.revertedWithCustomError(agent, "OwnableUnauthorizedAccount");
    });
  });

  describe("Score submission", () => {
    it("non-watcher cannot submit a score", async () => {
      const { agent, attacker, subject, agentAddr } = await deployAgent();

      const enc = await fhevm
        .createEncryptedInput(agentAddr, attacker.address)
        .add64(30000)
        .encrypt();

      await expect(
        agent.connect(attacker).submitScore(
          subject.address,
          getHandle(enc),
          getProof(enc)
        )
      ).to.be.revertedWithCustomError(agent, "NotWatcher");
    });

    it("watcher can submit a score below threshold (normal)", async () => {
      const { agent, agentAddr, watcher, subject } = await deployAgent();
      await (await agent.addWatcher(watcher.address)).wait();

      // Score = 20000, default threshold = 39321 → normal
      const enc = await fhevm
        .createEncryptedInput(agentAddr, watcher.address)
        .add64(20000)
        .encrypt();

      const tx = await agent.connect(watcher).submitScore(
        subject.address,
        getHandle(enc),
        getProof(enc)
      );
      const receipt = await tx.wait();
      expect(receipt?.status).to.equal(1);
    });

    it("watcher can submit a score above threshold (anomaly)", async () => {
      const { agent, agentAddr, watcher, subject } = await deployAgent();
      await (await agent.addWatcher(watcher.address)).wait();

      // Score = 50000, default threshold = 39321 → anomaly
      const enc = await fhevm
        .createEncryptedInput(agentAddr, watcher.address)
        .add64(50000)
        .encrypt();

      const tx = await agent.connect(watcher).submitScore(
        subject.address,
        getHandle(enc),
        getProof(enc)
      );
      const receipt = await tx.wait();
      expect(receipt?.status).to.equal(1);
    });

    it("submission is blocked when paused", async () => {
      const { agent, agentAddr, watcher, subject } = await deployAgent();
      await (await agent.addWatcher(watcher.address)).wait();
      await (await agent.pause()).wait();

      const enc = await fhevm
        .createEncryptedInput(agentAddr, watcher.address)
        .add64(20000)
        .encrypt();

      await expect(
        agent.connect(watcher).submitScore(
          subject.address,
          getHandle(enc),
          getProof(enc)
        )
      ).to.be.revertedWithCustomError(agent, "EnforcedPause");
    });
  });

  describe("Threshold update", () => {
    it("owner can update the encrypted threshold", async () => {
      const { agent, agentAddr, owner } = await deployAgent();

      const enc = await fhevm
        .createEncryptedInput(agentAddr, owner.address)
        .add64(50000)
        .encrypt();

      const tx = await agent.setThreshold(getHandle(enc), getProof(enc));
      const receipt = await tx.wait();
      expect(receipt?.status).to.equal(1);
    });

    it("non-owner cannot update the threshold", async () => {
      const { agent, agentAddr, attacker } = await deployAgent();

      const enc = await fhevm
        .createEncryptedInput(agentAddr, attacker.address)
        .add64(50000)
        .encrypt();

      await expect(
        agent.connect(attacker).setThreshold(getHandle(enc), getProof(enc))
      ).to.be.revertedWithCustomError(agent, "OwnableUnauthorizedAccount");
    });
  });
});