import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();
const { loadFixture, time } = networkHelpers;

describe("BusinessRegistry", function () {
  async function deployFixture() {
    const [admin, verifier, biz1, biz2, officer1, officer2, other] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("BusinessRegistry");
    const registry = await Registry.deploy(admin.address);

    const VERIFIER_ROLE = await registry.VERIFIER_ROLE();
    await registry.connect(admin).grantRole(VERIFIER_ROLE, verifier.address);

    return { registry, admin, verifier, biz1, biz2, officer1, officer2, other, VERIFIER_ROLE };
  }

  async function registeredFixture() {
    const fixture = await loadFixture(deployFixture);
    const { registry, biz1, officer1 } = fixture;
    await registry.connect(biz1).registerBusiness("ABC123", "Test Corp", 0, officer1.address);
    return fixture;
  }

  async function verifiedFixture() {
    const fixture = await registeredFixture();
    const { registry, verifier, biz1 } = fixture;
    await registry.connect(verifier).verifyBusiness(biz1.address);
    return fixture;
  }

  describe("Deployment", function () {
    it("should set admin roles correctly", async function () {
      const { registry, admin } = await loadFixture(deployFixture);
      const ADMIN_ROLE = await registry.ADMIN_ROLE();
      expect(await registry.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("should revert with zero admin address", async function () {
      const Registry = await ethers.getContractFactory("BusinessRegistry");
      await expect(Registry.deploy(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(Registry, "ZeroAddress");
    });
  });

  describe("Registration", function () {
    it("should register a UAE business", async function () {
      const { registry, biz1, officer1 } = await loadFixture(deployFixture);
      await expect(registry.connect(biz1).registerBusiness("ABC123", "Test Corp", 0, officer1.address))
        .to.emit(registry, "BusinessRegistered")
        .withArgs(biz1.address, "ABC123", "Test Corp", 0);
      expect(await registry.totalBusinesses()).to.equal(1);
    });

    it("should register an international business", async function () {
      const { registry, biz1, officer1 } = await loadFixture(deployFixture);
      await registry.connect(biz1).registerBusiness("INTL-123456", "Global Ltd", 1, officer1.address);
      const biz = await registry.getBusinessDetails(biz1.address);
      expect(biz.jurisdiction).to.equal(1);
    });

    it("should revert for duplicate registration", async function () {
      const { registry, biz1, officer1 } = await registeredFixture();
      await expect(registry.connect(biz1).registerBusiness("XYZ789", "Other Corp", 0, officer1.address))
        .to.be.revertedWithCustomError(registry, "BusinessAlreadyRegistered");
    });

    it("should revert for duplicate license", async function () {
      const { registry, biz2, officer1 } = await registeredFixture();
      await expect(registry.connect(biz2).registerBusiness("ABC123", "Other Corp", 0, officer1.address))
        .to.be.revertedWithCustomError(registry, "LicenseAlreadyRegistered");
    });

    it("should revert for zero compliance officer", async function () {
      const { registry, biz1 } = await loadFixture(deployFixture);
      await expect(registry.connect(biz1).registerBusiness("ABC123", "Test Corp", 0, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("should revert for empty business name", async function () {
      const { registry, biz1, officer1 } = await loadFixture(deployFixture);
      await expect(registry.connect(biz1).registerBusiness("ABC123", "", 0, officer1.address))
        .to.be.revertedWithCustomError(registry, "InvalidBusinessName");
    });

    it("should revert for license too short", async function () {
      const { registry, biz1, officer1 } = await loadFixture(deployFixture);
      await expect(registry.connect(biz1).registerBusiness("AB12", "Test", 0, officer1.address))
        .to.be.revertedWithCustomError(registry, "InvalidLicenseNumber");
    });

    it("should revert for license too long", async function () {
      const { registry, biz1, officer1 } = await loadFixture(deployFixture);
      await expect(registry.connect(biz1).registerBusiness("A".repeat(21), "Test", 0, officer1.address))
        .to.be.revertedWithCustomError(registry, "InvalidLicenseNumber");
    });

    it("should revert for UAE license with invalid chars", async function () {
      const { registry, biz1, officer1 } = await loadFixture(deployFixture);
      await expect(registry.connect(biz1).registerBusiness("ABC@#!", "Test", 0, officer1.address))
        .to.be.revertedWithCustomError(registry, "InvalidLicenseNumber");
    });

    it("should allow hyphens in UAE license", async function () {
      const { registry, biz1, officer1 } = await loadFixture(deployFixture);
      await registry.connect(biz1).registerBusiness("ABC-12-3", "Test Corp", 0, officer1.address);
      expect(await registry.totalBusinesses()).to.equal(1);
    });

    it("should revert when paused", async function () {
      const { registry, admin, biz1, officer1 } = await loadFixture(deployFixture);
      await registry.connect(admin).pause();
      await expect(registry.connect(biz1).registerBusiness("ABC123", "Test", 0, officer1.address))
        .to.be.revertedWith("Pausable: paused");
    });
  });

  describe("Verification", function () {
    it("should verify a pending business", async function () {
      const { registry, verifier, biz1 } = await registeredFixture();
      await expect(registry.connect(verifier).verifyBusiness(biz1.address))
        .to.emit(registry, "BusinessVerified");
      expect(await registry.verifiedBusinessCount()).to.equal(1);
    });

    it("should re-verify an already verified business", async function () {
      const { registry, verifier, biz1 } = await verifiedFixture();
      await registry.connect(verifier).verifyBusiness(biz1.address);
      expect(await registry.verifiedBusinessCount()).to.equal(1); // no double counting
    });

    it("should revert for non-existent business", async function () {
      const { registry, verifier, other } = await loadFixture(deployFixture);
      await expect(registry.connect(verifier).verifyBusiness(other.address))
        .to.be.revertedWithCustomError(registry, "BusinessNotFound");
    });

    it("should revert for non-verifier", async function () {
      const { registry, other, biz1 } = await registeredFixture();
      await expect(registry.connect(other).verifyBusiness(biz1.address))
        .to.be.revert(ethers);
    });
  });

  describe("Suspend & Reinstate", function () {
    it("should suspend a verified business", async function () {
      const { registry, verifier, biz1 } = await verifiedFixture();
      await expect(registry.connect(verifier).suspendBusiness(biz1.address, "AML concern"))
        .to.emit(registry, "BusinessSuspended")
        .withArgs(biz1.address, "AML concern");
      expect(await registry.verifiedBusinessCount()).to.equal(0);
    });

    it("should revert suspending non-verified business", async function () {
      const { registry, verifier, biz1 } = await registeredFixture();
      await expect(registry.connect(verifier).suspendBusiness(biz1.address, "reason"))
        .to.be.revertedWithCustomError(registry, "InvalidKYCStatus");
    });

    it("should reinstate a suspended business", async function () {
      const { registry, verifier, biz1 } = await verifiedFixture();
      await registry.connect(verifier).suspendBusiness(biz1.address, "temp");
      await expect(registry.connect(verifier).reinstateBusiness(biz1.address))
        .to.emit(registry, "BusinessReinstated");
      expect(await registry.verifiedBusinessCount()).to.equal(1);
    });

    it("should revert reinstating non-suspended business", async function () {
      const { registry, verifier, biz1 } = await verifiedFixture();
      await expect(registry.connect(verifier).reinstateBusiness(biz1.address))
        .to.be.revertedWithCustomError(registry, "InvalidKYCStatus");
    });
  });

  describe("Revoke", function () {
    it("should revoke a verified business", async function () {
      const { registry, admin, biz1 } = await verifiedFixture();
      await expect(registry.connect(admin).revokeBusiness(biz1.address, "fraud"))
        .to.emit(registry, "BusinessRevoked")
        .withArgs(biz1.address, "fraud");
      expect(await registry.verifiedBusinessCount()).to.equal(0);
    });

    it("should revoke a pending business", async function () {
      const { registry, admin, biz1 } = await registeredFixture();
      await registry.connect(admin).revokeBusiness(biz1.address, "invalid docs");
      const biz = await registry.getBusinessDetails(biz1.address);
      expect(biz.kycStatus).to.equal(3); // REVOKED
    });

    it("should revert for non-admin", async function () {
      const { registry, other, biz1 } = await verifiedFixture();
      await expect(registry.connect(other).revokeBusiness(biz1.address, "reason"))
        .to.be.revert(ethers);
    });
  });

  describe("Tier Management", function () {
    it("should upgrade tier from STANDARD to PREMIUM", async function () {
      const { registry, admin, biz1 } = await verifiedFixture();
      await expect(registry.connect(admin).upgradeTier(biz1.address, 1))
        .to.emit(registry, "TierUpgraded")
        .withArgs(biz1.address, 0, 1);
    });

    it("should upgrade tier from PREMIUM to ENTERPRISE", async function () {
      const { registry, admin, biz1 } = await verifiedFixture();
      await registry.connect(admin).upgradeTier(biz1.address, 1);
      await registry.connect(admin).upgradeTier(biz1.address, 2);
      expect(await registry.getBusinessTier(biz1.address)).to.equal(2);
    });

    it("should revert downgrade", async function () {
      const { registry, admin, biz1 } = await verifiedFixture();
      await registry.connect(admin).upgradeTier(biz1.address, 1);
      await expect(registry.connect(admin).upgradeTier(biz1.address, 0))
        .to.be.revertedWithCustomError(registry, "CannotDowngradeTier");
    });

    it("should revert same tier", async function () {
      const { registry, admin, biz1 } = await verifiedFixture();
      await expect(registry.connect(admin).upgradeTier(biz1.address, 0))
        .to.be.revertedWithCustomError(registry, "CannotDowngradeTier");
    });

    it("should revert already at max tier", async function () {
      const { registry, admin, biz1 } = await verifiedFixture();
      await registry.connect(admin).upgradeTier(biz1.address, 2);
      await expect(registry.connect(admin).upgradeTier(biz1.address, 2))
        .to.be.revertedWithCustomError(registry, "AlreadyAtMaxTier");
    });

    it("should revert upgrade for non-verified", async function () {
      const { registry, admin, biz1 } = await registeredFixture();
      await expect(registry.connect(admin).upgradeTier(biz1.address, 1))
        .to.be.revertedWithCustomError(registry, "InvalidKYCStatus");
    });
  });

  describe("Compliance Officer", function () {
    it("should update compliance officer", async function () {
      const { registry, biz1, officer1, officer2 } = await registeredFixture();
      await expect(registry.connect(biz1).updateComplianceOfficer(officer2.address))
        .to.emit(registry, "ComplianceOfficerUpdated")
        .withArgs(biz1.address, officer1.address, officer2.address);
    });

    it("should revert for zero address", async function () {
      const { registry, biz1 } = await registeredFixture();
      await expect(registry.connect(biz1).updateComplianceOfficer(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("should revert for non-registered caller", async function () {
      const { registry, other, officer1 } = await loadFixture(deployFixture);
      await expect(registry.connect(other).updateComplianceOfficer(officer1.address))
        .to.be.revertedWithCustomError(registry, "BusinessNotFound");
    });
  });

  describe("View Functions", function () {
    it("should return active status for verified business", async function () {
      const { registry, biz1 } = await verifiedFixture();
      expect(await registry.isBusinessActive(biz1.address)).to.be.true;
    });

    it("should return inactive for pending business", async function () {
      const { registry, biz1 } = await registeredFixture();
      expect(await registry.isBusinessActive(biz1.address)).to.be.false;
    });

    it("should return inactive after reverification expires", async function () {
      const { registry, biz1 } = await verifiedFixture();
      await time.increase(366 * 24 * 60 * 60); // > 365 days
      expect(await registry.isBusinessActive(biz1.address)).to.be.false;
    });

    it("should indicate reverification needed after interval", async function () {
      const { registry, biz1 } = await verifiedFixture();
      await time.increase(365 * 24 * 60 * 60);
      expect(await registry.needsReverification(biz1.address)).to.be.true;
    });

    it("should not need reverification immediately after verify", async function () {
      const { registry, biz1 } = await verifiedFixture();
      expect(await registry.needsReverification(biz1.address)).to.be.false;
    });
  });

  describe("Admin", function () {
    it("should set NoblePay contract", async function () {
      const { registry, admin, other } = await loadFixture(deployFixture);
      await expect(registry.connect(admin).setNoblePayContract(other.address))
        .to.emit(registry, "NoblePayContractUpdated");
    });

    it("should revert setNoblePayContract with zero address", async function () {
      const { registry, admin } = await loadFixture(deployFixture);
      await expect(registry.connect(admin).setNoblePayContract(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("should pause and unpause", async function () {
      const { registry, admin } = await loadFixture(deployFixture);
      await registry.connect(admin).pause();
      expect(await registry.paused()).to.be.true;
      await registry.connect(admin).unpause();
      expect(await registry.paused()).to.be.false;
    });

    it("should revert pause for non-admin", async function () {
      const { registry, other } = await loadFixture(deployFixture);
      await expect(registry.connect(other).pause()).to.be.revert(ethers);
    });
  });
});
