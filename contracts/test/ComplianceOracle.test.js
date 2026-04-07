import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();
const { loadFixture, time } = networkHelpers;

describe("ComplianceOracle", function () {
  async function deployFixture() {
    const [admin, teeManager, thresholdMgr, thresholdMgr2, node1, node2, other] = await ethers.getSigners();

    const Oracle = await ethers.getContractFactory("ComplianceOracle");
    const oracle = await Oracle.deploy(admin.address);

    const TEE_MANAGER_ROLE = await oracle.TEE_MANAGER_ROLE();
    const THRESHOLD_MANAGER_ROLE = await oracle.THRESHOLD_MANAGER_ROLE();

    await oracle.connect(admin).grantRole(TEE_MANAGER_ROLE, teeManager.address);
    await oracle.connect(admin).grantRole(THRESHOLD_MANAGER_ROLE, thresholdMgr.address);
    await oracle.connect(admin).grantRole(THRESHOLD_MANAGER_ROLE, thresholdMgr2.address);

    return { oracle, admin, teeManager, thresholdMgr, thresholdMgr2, node1, node2, other, TEE_MANAGER_ROLE, THRESHOLD_MANAGER_ROLE };
  }

  async function nodeRegisteredFixture() {
    const fixture = await loadFixture(deployFixture);
    const { oracle, node1 } = fixture;
    const enclaveKey = ethers.toUtf8Bytes("enclave-public-key-data");
    const platformId = ethers.keccak256(ethers.toUtf8Bytes("sgx-platform"));
    await oracle.connect(node1).registerTEENode(enclaveKey, platformId, { value: ethers.parseEther("10") });
    return { ...fixture, enclaveKey, platformId };
  }

  describe("Deployment", function () {
    it("should set admin roles and default thresholds", async function () {
      const { oracle, admin } = await loadFixture(deployFixture);
      const ADMIN_ROLE = await oracle.ADMIN_ROLE();
      expect(await oracle.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
      const [lowMax, mediumMax] = await oracle.getRiskThresholds();
      expect(lowMax).to.equal(29);
      expect(mediumMax).to.equal(70);
    });

    it("should revert with zero admin", async function () {
      const Oracle = await ethers.getContractFactory("ComplianceOracle");
      await expect(Oracle.deploy(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(Oracle, "ZeroAddress");
    });
  });

  describe("TEE Node Registration", function () {
    it("should register a TEE node with sufficient stake", async function () {
      const { oracle, node1 } = await loadFixture(deployFixture);
      const enclaveKey = ethers.toUtf8Bytes("key");
      const platformId = ethers.keccak256(ethers.toUtf8Bytes("platform"));
      await expect(oracle.connect(node1).registerTEENode(enclaveKey, platformId, { value: ethers.parseEther("10") }))
        .to.emit(oracle, "TEENodeRegistered");
      expect(await oracle.getActiveTEENodeCount()).to.equal(1);
    });

    it("should revert with insufficient stake", async function () {
      const { oracle, node1 } = await loadFixture(deployFixture);
      await expect(oracle.connect(node1).registerTEENode("0x", ethers.ZeroHash, { value: ethers.parseEther("5") }))
        .to.be.revertedWithCustomError(oracle, "InsufficientStake");
    });

    it("should revert for duplicate registration", async function () {
      const { oracle, node1 } = await nodeRegisteredFixture();
      await expect(oracle.connect(node1).registerTEENode("0x", ethers.ZeroHash, { value: ethers.parseEther("10") }))
        .to.be.revertedWithCustomError(oracle, "NodeAlreadyRegistered");
    });
  });

  describe("TEE Node Deregistration", function () {
    it("should deregister by operator and return stake", async function () {
      const { oracle, node1 } = await nodeRegisteredFixture();
      const balBefore = await ethers.provider.getBalance(node1.address);
      const tx = await oracle.connect(node1).deregisterTEENode(node1.address);
      const receipt = await tx.wait();
      const balAfter = await ethers.provider.getBalance(node1.address);
      // Should have gotten ~10 ETH back minus gas
      expect(balAfter - balBefore + receipt.gasUsed * receipt.gasPrice).to.be.closeTo(ethers.parseEther("10"), ethers.parseEther("0.01"));
      expect(await oracle.getActiveTEENodeCount()).to.equal(0);
    });

    it("should deregister by TEE manager", async function () {
      const { oracle, teeManager, node1 } = await nodeRegisteredFixture();
      await expect(oracle.connect(teeManager).deregisterTEENode(node1.address))
        .to.emit(oracle, "TEENodeDeregistered");
    });

    it("should revert deregister by unauthorized", async function () {
      const { oracle, other, node1 } = await nodeRegisteredFixture();
      await expect(oracle.connect(other).deregisterTEENode(node1.address))
        .to.be.revertedWith("ComplianceOracle: unauthorized");
    });

    it("should revert for non-existent node", async function () {
      const { oracle, other } = await loadFixture(deployFixture);
      await expect(oracle.connect(other).deregisterTEENode(other.address))
        .to.be.revertedWithCustomError(oracle, "NodeNotFound");
    });
  });

  describe("Heartbeat", function () {
    it("should record heartbeat", async function () {
      const { oracle, node1 } = await nodeRegisteredFixture();
      await expect(oracle.connect(node1).heartbeat())
        .to.emit(oracle, "TEENodeHeartbeat");
    });

    it("should revert for unregistered node", async function () {
      const { oracle, other } = await loadFixture(deployFixture);
      await expect(oracle.connect(other).heartbeat())
        .to.be.revertedWithCustomError(oracle, "NodeNotFound");
    });
  });

  describe("Slashing", function () {
    it("should slash an offline node", async function () {
      const { oracle, teeManager, node1 } = await nodeRegisteredFixture();
      await time.increase(301); // > 5 minutes
      await expect(oracle.connect(teeManager).slashOfflineNode(node1.address))
        .to.emit(oracle, "TEENodeSlashed");
      const node = await oracle.getTEENode(node1.address);
      expect(node.slashCount).to.equal(1);
      // 5% of 10 ETH = 0.5 ETH slashed
      expect(node.stake).to.equal(ethers.parseEther("9.5"));
    });

    it("should revert if node is not offline", async function () {
      const { oracle, teeManager, node1 } = await nodeRegisteredFixture();
      await expect(oracle.connect(teeManager).slashOfflineNode(node1.address))
        .to.be.revertedWith("ComplianceOracle: node not offline");
    });

    it("should auto-deregister after MAX_SLASH_COUNT", async function () {
      const { oracle, teeManager, node1 } = await nodeRegisteredFixture();
      for (let i = 0; i < 3; i++) {
        await time.increase(301);
        await oracle.connect(teeManager).slashOfflineNode(node1.address);
        // Re-activate via heartbeat except after the final slash
        if (i < 2) {
          // node still active, send heartbeat wouldn't work after slash 3 since it becomes SLASHED
        }
      }
      const node = await oracle.getTEENode(node1.address);
      expect(node.status).to.equal(3); // SLASHED
      expect(await oracle.getActiveTEENodeCount()).to.equal(0);
    });
  });

  describe("Attestation Verification", function () {
    it("should verify a valid attestation", async function () {
      const { oracle, teeManager, node1 } = await nodeRegisteredFixture();
      const attestationData = ethers.toUtf8Bytes("attestation-data");
      const expectedHash = ethers.keccak256(attestationData);
      await expect(oracle.connect(teeManager).verifyAttestation(node1.address, attestationData, expectedHash))
        .to.emit(oracle, "AttestationVerified");
    });

    it("should revert with mismatched hash", async function () {
      const { oracle, teeManager, node1 } = await nodeRegisteredFixture();
      const attestationData = ethers.toUtf8Bytes("attestation-data");
      await expect(oracle.connect(teeManager).verifyAttestation(node1.address, attestationData, ethers.ZeroHash))
        .to.be.revertedWithCustomError(oracle, "InvalidAttestation");
    });

    it("should revert for non-existent node", async function () {
      const { oracle, teeManager, other } = await loadFixture(deployFixture);
      await expect(oracle.connect(teeManager).verifyAttestation(other.address, "0x", ethers.ZeroHash))
        .to.be.revertedWithCustomError(oracle, "NodeNotFound");
    });
  });

  describe("Sanctions List", function () {
    it("should update sanctions list", async function () {
      const { oracle, admin } = await loadFixture(deployFixture);
      const listHash = ethers.keccak256(ethers.toUtf8Bytes("ofac-list"));
      await expect(oracle.connect(admin).updateSanctionsList(0, listHash))
        .to.emit(oracle, "SanctionsListUpdated")
        .withArgs(0, listHash, 1);
      expect(await oracle.getSanctionsListVersion(0)).to.equal(1);
    });

    it("should increment version on subsequent updates", async function () {
      const { oracle, admin } = await loadFixture(deployFixture);
      const hash1 = ethers.keccak256(ethers.toUtf8Bytes("v1"));
      const hash2 = ethers.keccak256(ethers.toUtf8Bytes("v2"));
      await oracle.connect(admin).updateSanctionsList(0, hash1);
      await oracle.connect(admin).updateSanctionsList(0, hash2);
      expect(await oracle.getSanctionsListVersion(0)).to.equal(2);
    });
  });

  describe("Threshold Management", function () {
    it("should propose and approve threshold update", async function () {
      const { oracle, thresholdMgr, thresholdMgr2 } = await loadFixture(deployFixture);
      const tx = await oracle.connect(thresholdMgr).proposeThresholdUpdate(20, 60);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ThresholdChangeProposed");
      const proposalId = event.args[0];

      await oracle.connect(thresholdMgr2).approveThresholdUpdate(proposalId, 20, 60);
      const [lowMax, mediumMax] = await oracle.getRiskThresholds();
      expect(lowMax).to.equal(20);
      expect(mediumMax).to.equal(60);
    });

    it("should revert invalid thresholds (lowMax >= mediumMax)", async function () {
      const { oracle, thresholdMgr } = await loadFixture(deployFixture);
      await expect(oracle.connect(thresholdMgr).proposeThresholdUpdate(70, 60))
        .to.be.revertedWithCustomError(oracle, "InvalidThresholds");
    });

    it("should revert invalid thresholds (mediumMax > 100)", async function () {
      const { oracle, thresholdMgr } = await loadFixture(deployFixture);
      await expect(oracle.connect(thresholdMgr).proposeThresholdUpdate(20, 101))
        .to.be.revertedWithCustomError(oracle, "InvalidThresholds");
    });

    it("should revert duplicate vote", async function () {
      const { oracle, thresholdMgr } = await loadFixture(deployFixture);
      const tx = await oracle.connect(thresholdMgr).proposeThresholdUpdate(20, 60);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ThresholdChangeProposed");
      const proposalId = event.args[0];

      await expect(oracle.connect(thresholdMgr).approveThresholdUpdate(proposalId, 20, 60))
        .to.be.revertedWithCustomError(oracle, "AlreadyVoted");
    });
  });

  describe("Screening Results", function () {
    it("should submit screening result from active node", async function () {
      const { oracle, node1 } = await nodeRegisteredFixture();
      const subjectHash = ethers.keccak256(ethers.toUtf8Bytes("subject"));
      const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result"));
      await expect(oracle.connect(node1).submitScreeningResult(subjectHash, resultHash, 25, true))
        .to.emit(oracle, "ScreeningResultSubmitted");
    });

    it("should revert for unregistered node", async function () {
      const { oracle, other } = await loadFixture(deployFixture);
      await expect(oracle.connect(other).submitScreeningResult(ethers.ZeroHash, ethers.ZeroHash, 50, true))
        .to.be.revertedWithCustomError(oracle, "NodeNotFound");
    });

    it("should revert for invalid risk score > 100", async function () {
      const { oracle, node1 } = await nodeRegisteredFixture();
      await expect(oracle.connect(node1).submitScreeningResult(ethers.ZeroHash, ethers.ZeroHash, 101, true))
        .to.be.revertedWithCustomError(oracle, "InvalidRiskScore");
    });
  });

  describe("View Functions", function () {
    it("should classify risk scores correctly", async function () {
      const { oracle } = await loadFixture(deployFixture);
      expect(await oracle.classifyRisk(10)).to.equal("LOW");
      expect(await oracle.classifyRisk(29)).to.equal("LOW");
      expect(await oracle.classifyRisk(30)).to.equal("MEDIUM");
      expect(await oracle.classifyRisk(70)).to.equal("MEDIUM");
      expect(await oracle.classifyRisk(71)).to.equal("HIGH");
      expect(await oracle.classifyRisk(100)).to.equal("HIGH");
    });
  });

  describe("Admin", function () {
    it("should pause and unpause", async function () {
      const { oracle, admin } = await loadFixture(deployFixture);
      await oracle.connect(admin).pause();
      expect(await oracle.paused()).to.be.true;
      await oracle.connect(admin).unpause();
      expect(await oracle.paused()).to.be.false;
    });

    it("should revert pause for non-admin", async function () {
      const { oracle, other } = await loadFixture(deployFixture);
      await expect(oracle.connect(other).pause()).to.be.revert(ethers);
    });
  });
});
