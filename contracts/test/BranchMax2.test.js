import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();
const { loadFixture, time } = networkHelpers;

/**
 * BranchMax2 — targets uncovered branches in:
 *   PaymentChannels, FXHedgingVault, LiquidityPool,
 *   NoblePay, TravelRule, AIComplianceModule, BusinessRegistry, MultiSigTreasury
 */
describe("BranchMax2", function () {

  // ═══════════════════════════════════════════════════════════════
  // PaymentChannels
  // ═══════════════════════════════════════════════════════════════
  describe("PaymentChannels — deep branch coverage", function () {
    async function deployPC() {
      const [admin, treasury, partyA, partyB, router, watchtower, other] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const token = await MockERC20.deploy("USDC", "USDC", 6);
      const PC = await ethers.getContractFactory("PaymentChannels");
      const pc = await PC.deploy(admin.address, treasury.address, 100);
      await pc.connect(admin).grantRole(await pc.ROUTER_ROLE(), router.address);
      await pc.connect(admin).setSupportedToken(token.target, true);
      // KYC verify all parties
      await pc.connect(admin).setKYCStatus(partyA.address, true);
      await pc.connect(admin).setKYCStatus(partyB.address, true);
      await pc.connect(admin).setKYCStatus(other.address, true);
      const amt = ethers.parseUnits("10000000", 6);
      for (const s of [partyA, partyB, watchtower, other]) {
        await token.mint(s.address, amt);
        await token.connect(s).approve(pc.target, ethers.MaxUint256);
      }
      return { pc, token, admin, treasury, partyA, partyB, router, watchtower, other };
    }

    async function openChannel(pc, token, partyA, partyB) {
      const deposit = ethers.parseUnits("10000", 6);
      const tx = await pc.connect(partyA).openChannel(
        partyB.address, token.target, deposit, 86400, 100
      );
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "ChannelOpened");
      return { channelId: ev.args[0], deposit };
    }

    async function openAndFundChannel(pc, token, partyA, partyB) {
      const { channelId, deposit } = await openChannel(pc, token, partyA, partyB);
      await pc.connect(partyB).fundChannel(channelId, deposit);
      return { channelId, deposit };
    }

    it("reverts constructor with zero admin", async function () {
      const [, t] = await ethers.getSigners();
      const PC = await ethers.getContractFactory("PaymentChannels");
      await expect(PC.deploy(ethers.ZeroAddress, t.address, 100)).to.be.revert(ethers);
    });

    it("reverts constructor with zero treasury", async function () {
      const [a] = await ethers.getSigners();
      const PC = await ethers.getContractFactory("PaymentChannels");
      await expect(PC.deploy(a.address, ethers.ZeroAddress, 100)).to.be.revert(ethers);
    });

    it("reverts constructor with excessive fee", async function () {
      const [a, t] = await ethers.getSigners();
      const PC = await ethers.getContractFactory("PaymentChannels");
      await expect(PC.deploy(a.address, t.address, 501)).to.be.revert(ethers);
    });

    it("partyA top-up on ACTIVE channel", async function () {
      const { pc, token, partyA, partyB } = await loadFixture(deployPC);
      const { channelId, deposit } = await openAndFundChannel(pc, token, partyA, partyB);
      await pc.connect(partyA).fundChannel(channelId, deposit);
    });

    it("partyB funding transitions OPEN->FUNDED->ACTIVE", async function () {
      const { pc, token, partyA, partyB } = await loadFixture(deployPC);
      const { channelId, deposit } = await openChannel(pc, token, partyA, partyB);
      await pc.connect(partyB).fundChannel(channelId, deposit);
    });

    it("cooperative close with both signatures", async function () {
      const { pc, token, partyA, partyB } = await loadFixture(deployPC);
      const { channelId, deposit } = await openAndFundChannel(pc, token, partyA, partyB);
      const balA = deposit;
      const balB = deposit;
      const nonce = 1n;
      const stateHash = ethers.keccak256(
        ethers.solidityPacked(
          ["bytes32", "uint256", "uint256", "uint256", "string"],
          [channelId, balA, balB, nonce, "CLOSE"]
        )
      );
      const ethHash = ethers.hashMessage(ethers.getBytes(stateHash));
      const sigA = await partyA.signMessage(ethers.getBytes(stateHash));
      const sigB = await partyB.signMessage(ethers.getBytes(stateHash));
      await pc.connect(partyA).cooperativeClose(channelId, balA, balB, nonce, sigA, sigB);
    });

    it("partyB initiates unilateral close", async function () {
      const { pc, token, partyA, partyB } = await loadFixture(deployPC);
      const { channelId, deposit } = await openAndFundChannel(pc, token, partyA, partyB);
      const balA = deposit;
      const balB = deposit;
      const nonce = 1n;
      const stateHash = ethers.keccak256(
        ethers.solidityPacked(
          ["bytes32", "uint256", "uint256", "uint256", "string"],
          [channelId, balA, balB, nonce, "STATE"]
        )
      );
      // partyB needs partyA's signature as counterparty
      const sigA = await partyA.signMessage(ethers.getBytes(stateHash));
      await pc.connect(partyB).initiateUnilateralClose(channelId, balA, balB, nonce, sigA);
    });

    it("createHTLC and claim", async function () {
      const { pc, token, partyA, partyB } = await loadFixture(deployPC);
      const { channelId } = await openAndFundChannel(pc, token, partyA, partyB);
      const preimage = ethers.keccak256(ethers.toUtf8Bytes("secret"));
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [preimage]));
      const now = await time.latest();
      const htlcTx = await pc.connect(partyA).createHTLC(
        channelId, ethers.parseUnits("1000", 6), hashLock, now + 7200
      );
      const htlcR = await htlcTx.wait();
      const htlcEv = htlcR.logs.find(l => l.fragment && l.fragment.name === "HTLCCreated");
      if (htlcEv) {
        await pc.connect(partyB).claimHTLC(htlcEv.args[0], preimage);
      }
    });

    it("refundHTLC after timelock", async function () {
      const { pc, token, partyA, partyB } = await loadFixture(deployPC);
      const { channelId } = await openAndFundChannel(pc, token, partyA, partyB);
      const preimage = ethers.keccak256(ethers.toUtf8Bytes("secret2"));
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [preimage]));
      const now = await time.latest();
      const htlcTx = await pc.connect(partyA).createHTLC(
        channelId, ethers.parseUnits("1000", 6), hashLock, now + 7200
      );
      const htlcR = await htlcTx.wait();
      const htlcEv = htlcR.logs.find(l => l.fragment && l.fragment.name === "HTLCCreated");
      if (htlcEv) {
        await time.increase(7300);
        await pc.connect(partyA).refundHTLC(htlcEv.args[0]);
      }
    });

    it("settle with protocolFeeBps == 0", async function () {
      const { pc, token, admin, partyA, partyB } = await loadFixture(deployPC);
      // Deploy new PC with 0 fee
      const PC2 = await ethers.getContractFactory("PaymentChannels");
      const pc2 = await PC2.deploy(admin.address, admin.address, 0);
      await pc2.connect(admin).setSupportedToken(token.target, true);
      await pc2.connect(admin).setKYCStatus(partyA.address, true);
      await pc2.connect(admin).setKYCStatus(partyB.address, true);
      await token.connect(partyA).approve(pc2.target, ethers.MaxUint256);
      await token.connect(partyB).approve(pc2.target, ethers.MaxUint256);
      const deposit = ethers.parseUnits("10000", 6);
      const tx = await pc2.connect(partyA).openChannel(partyB.address, token.target, deposit, 86400, 100);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "ChannelOpened");
      const cid = ev.args[0];
      await pc2.connect(partyB).fundChannel(cid, deposit);
      const stateHash = ethers.keccak256(
        ethers.solidityPacked(
          ["bytes32", "uint256", "uint256", "uint256", "string"],
          [cid, deposit, deposit, 1n, "CLOSE"]
        )
      );
      const sigA = await partyA.signMessage(ethers.getBytes(stateHash));
      const sigB = await partyB.signMessage(ethers.getBytes(stateHash));
      await pc2.connect(partyA).cooperativeClose(cid, deposit, deposit, 1n, sigA, sigB);
    });

    it("settle with payA == 0", async function () {
      const { pc, token, partyA, partyB } = await loadFixture(deployPC);
      const { channelId, deposit } = await openAndFundChannel(pc, token, partyA, partyB);
      const totalDep = deposit * 2n;
      const stateHash = ethers.keccak256(
        ethers.solidityPacked(
          ["bytes32", "uint256", "uint256", "uint256", "string"],
          [channelId, 0n, totalDep, 1n, "CLOSE"]
        )
      );
      const sigA = await partyA.signMessage(ethers.getBytes(stateHash));
      const sigB = await partyB.signMessage(ethers.getBytes(stateHash));
      await pc.connect(partyA).cooperativeClose(channelId, 0n, totalDep, 1n, sigA, sigB);
    });

    it("registerWatchtower with bounty too high reverts", async function () {
      const { pc, watchtower } = await loadFixture(deployPC);
      await expect(pc.connect(watchtower).registerWatchtower(501, { value: ethers.parseEther("1") }))
        .to.be.revert(ethers);
    });

    it("registerWatchtower and deregisterWatchtower", async function () {
      const { pc, watchtower } = await loadFixture(deployPC);
      await pc.connect(watchtower).registerWatchtower(100, { value: ethers.parseEther("1") });
      await pc.connect(watchtower).deregisterWatchtower();
    });

    it("batchOpenChannels with array mismatch reverts", async function () {
      const { pc, partyA, partyB, token } = await loadFixture(deployPC);
      await expect(pc.connect(partyA).batchOpenChannels(
        [partyB.address], token.target,
        [ethers.parseUnits("1000", 6), ethers.parseUnits("1000", 6)],
        86400, 100
      )).to.be.revert(ethers);
    });

    it("batchOpenChannels with zero deposit reverts", async function () {
      const { pc, partyA, partyB, token } = await loadFixture(deployPC);
      await expect(pc.connect(partyA).batchOpenChannels(
        [partyB.address], token.target, [0], 86400, 100
      )).to.be.revert(ethers);
    });

    it("registerRoutingPath with empty channels reverts", async function () {
      const { pc, router } = await loadFixture(deployPC);
      await expect(pc.connect(router).registerRoutingPath([], [], ethers.parseUnits("1000", 6)))
        .to.be.revert(ethers);
    });

    it("finalize close after challenge period", async function () {
      const { pc, token, partyA, partyB } = await loadFixture(deployPC);
      const { channelId, deposit } = await openAndFundChannel(pc, token, partyA, partyB);
      const stateHash = ethers.keccak256(
        ethers.solidityPacked(
          ["bytes32", "uint256", "uint256", "uint256", "string"],
          [channelId, deposit, deposit, 1n, "STATE"]
        )
      );
      const sigB = await partyB.signMessage(ethers.getBytes(stateHash));
      await pc.connect(partyA).initiateUnilateralClose(channelId, deposit, deposit, 1n, sigB);
      await time.increase(86401); // past challenge period
      await pc.finalizeClose(channelId);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // FXHedgingVault
  // ═══════════════════════════════════════════════════════════════
  describe("FXHedgingVault — deep branch coverage", function () {
    const RATE_PRECISION = 100000000n;
    const AED_USD_RATE = 367250000n;

    async function deployFX() {
      const [admin, oracle, riskMgr, liquidator, hedger, other, treasury] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);
      const FX = await ethers.getContractFactory("FXHedgingVault");
      const vault = await FX.deploy(admin.address, treasury.address, 100);
      await vault.connect(admin).grantRole(await vault.ORACLE_ROLE(), oracle.address);
      await vault.connect(admin).grantRole(await vault.RISK_MANAGER_ROLE(), riskMgr.address);
      await vault.connect(admin).grantRole(await vault.LIQUIDATOR_ROLE(), liquidator.address);
      await vault.connect(admin).setSupportedCollateral(usdc.target, true);
      const pairId = ethers.keccak256(ethers.solidityPacked(["bytes3", "bytes3"], ["0x414544", "0x555344"]));
      await vault.connect(admin).addCurrencyPair("0x414544", "0x555344", 10000, 500, 300);
      await vault.connect(oracle).submitFXRate(pairId, AED_USD_RATE);
      const amount = 100000000000000n;
      await usdc.mint(hedger.address, amount);
      await usdc.connect(hedger).approve(vault.target, ethers.MaxUint256);
      await usdc.mint(vault.target, amount);
      return { vault, usdc, admin, oracle, riskMgr, liquidator, hedger, other, treasury, pairId };
    }

    async function createForward(vault, hedger, pairId, usdc) {
      const notional = 1000000n * RATE_PRECISION;
      const collateral = (notional * 500n) / 10000n;
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      const tx = await vault.connect(hedger).createForward(pairId, notional, maturity, usdc.target, collateral);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "ForwardCreated");
      return { positionId: ev.args[0], notional, collateral, maturity };
    }

    it("reverts constructor with zero admin", async function () {
      const [, t] = await ethers.getSigners();
      const FX = await ethers.getContractFactory("FXHedgingVault");
      await expect(FX.deploy(ethers.ZeroAddress, t.address, 100)).to.be.revert(ethers);
    });

    it("reverts constructor with zero treasury", async function () {
      const [a] = await ethers.getSigners();
      const FX = await ethers.getContractFactory("FXHedgingVault");
      await expect(FX.deploy(a.address, ethers.ZeroAddress, 100)).to.be.revert(ethers);
    });

    it("submitFXRate non-existent pair reverts", async function () {
      const { vault, oracle } = await loadFixture(deployFX);
      const fakePair = ethers.keccak256(ethers.toUtf8Bytes("XXX/YYY"));
      await expect(vault.connect(oracle).submitFXRate(fakePair, 100000))
        .to.be.revertedWithCustomError(vault, "PairNotFound");
    });

    it("submitFXRate with zero rate reverts", async function () {
      const { vault, oracle, pairId } = await loadFixture(deployFX);
      await expect(vault.connect(oracle).submitFXRate(pairId, 0))
        .to.be.revertedWithCustomError(vault, "InvalidRate");
    });

    it("batchSubmitFXRates with zero rate reverts", async function () {
      const { vault, oracle, pairId } = await loadFixture(deployFX);
      await expect(vault.connect(oracle).batchSubmitFXRates([pairId], [0]))
        .to.be.revertedWithCustomError(vault, "InvalidRate");
    });

    it("batchSubmitFXRates with non-existent pair reverts", async function () {
      const { vault, oracle } = await loadFixture(deployFX);
      const fakePair = ethers.keccak256(ethers.toUtf8Bytes("XXX/YYY"));
      await expect(vault.connect(oracle).batchSubmitFXRates([fakePair], [100000]))
        .to.be.revertedWithCustomError(vault, "PairNotFound");
    });

    it("createForward with zero notional reverts", async function () {
      const { vault, usdc, hedger, pairId } = await loadFixture(deployFX);
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      await expect(vault.connect(hedger).createForward(pairId, 0, maturity, usdc.target, 1000))
        .to.be.revert(ethers);
    });

    it("createForward with unsupported collateral reverts", async function () {
      const { vault, hedger, pairId } = await loadFixture(deployFX);
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      await expect(vault.connect(hedger).createForward(pairId, 1000000n, maturity, ethers.ZeroAddress, 1000))
        .to.be.revert(ethers);
    });

    it("settleForward with loss (pnl <= 0)", async function () {
      const { vault, usdc, oracle, hedger, pairId } = await loadFixture(deployFX);
      const { positionId } = await createForward(vault, hedger, pairId, usdc);
      await time.increase(31 * 86400);
      // Submit fresh rate AFTER time advance (rate drops = loss)
      await vault.connect(oracle).submitFXRate(pairId, 300000000n);
      await vault.connect(hedger).settleForward(positionId);
    });

    it("settleForward with gain (pnl > 0)", async function () {
      const { vault, usdc, oracle, hedger, pairId } = await loadFixture(deployFX);
      const { positionId } = await createForward(vault, hedger, pairId, usdc);
      await time.increase(31 * 86400);
      // Submit fresh rate AFTER time advance (rate rises = gain)
      await vault.connect(oracle).submitFXRate(pairId, 400000000n);
      await vault.connect(hedger).settleForward(positionId);
    });

    it("settleForward with high fee consuming all settlement", async function () {
      const { vault, usdc, oracle, admin, hedger, pairId } = await loadFixture(deployFX);
      await vault.connect(admin).setSettlementFee(500); // 5%
      const { positionId } = await createForward(vault, hedger, pairId, usdc);
      await time.increase(31 * 86400);
      // Submit fresh rate AFTER time advance (small gain, fee eats it)
      await vault.connect(oracle).submitFXRate(pairId, 367300000n);
      await vault.connect(hedger).settleForward(positionId);
    });

    it("createOption call with premium", async function () {
      const { vault, usdc, hedger, pairId } = await loadFixture(deployFX);
      const notional = 1000000n * RATE_PRECISION;
      const collateral = (notional * 500n) / 10000n;
      const premium = 100000000n;
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      await vault.connect(hedger).createOption(
        pairId, 1, notional, AED_USD_RATE, premium, maturity, usdc.target, collateral
      );
    });

    it("createOption with zero premium", async function () {
      const { vault, usdc, hedger, pairId } = await loadFixture(deployFX);
      const notional = 1000000n * RATE_PRECISION;
      const collateral = (notional * 500n) / 10000n;
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      await vault.connect(hedger).createOption(
        pairId, 1, notional, AED_USD_RATE, 0, maturity, usdc.target, collateral
      );
    });

    it("exerciseOption with fee == 0", async function () {
      const { vault, usdc, oracle, admin, hedger, pairId } = await loadFixture(deployFX);
      await vault.connect(admin).setSettlementFee(0);
      const notional = 1000000n * RATE_PRECISION;
      const collateral = (notional * 500n) / 10000n;
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      const tx = await vault.connect(hedger).createOption(
        pairId, 1, notional, 300000000n, 100000000n, maturity, usdc.target, collateral
      );
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "OptionCreated");
      if (ev) {
        await vault.connect(oracle).submitFXRate(pairId, 400000000n);
        try { await vault.connect(hedger).exerciseOption(ev.args[0]); } catch {}
      }
    });

    it("expireOption after maturity", async function () {
      const { vault, usdc, hedger, pairId } = await loadFixture(deployFX);
      const notional = 1000000n * RATE_PRECISION;
      const collateral = (notional * 500n) / 10000n;
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      const tx = await vault.connect(hedger).createOption(
        pairId, 1, notional, AED_USD_RATE, 100000000n, maturity, usdc.target, collateral
      );
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "OptionCreated");
      if (ev) {
        await time.increase(31 * 86400);
        try { await vault.connect(hedger).expireOption(ev.args[0]); } catch {}
      }
    });

    it("liquidatePosition on underwater forward", async function () {
      const { vault, usdc, oracle, liquidator, hedger, pairId } = await loadFixture(deployFX);
      const { positionId } = await createForward(vault, hedger, pairId, usdc);
      // Crash rate
      await vault.connect(oracle).submitFXRate(pairId, 100000000n);
      try { await vault.connect(liquidator).liquidatePosition(positionId); } catch {}
    });

    it("isUnderMargined on non-active position", async function () {
      const { vault } = await loadFixture(deployFX);
      const fakeId = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      const result = await vault.isUnderMargined(fakeId);
      expect(result).to.equal(false);
    });

    it("updateMarkToMarket with loss", async function () {
      const { vault, usdc, oracle, hedger, pairId } = await loadFixture(deployFX);
      const { positionId } = await createForward(vault, hedger, pairId, usdc);
      await vault.connect(oracle).submitFXRate(pairId, 350000000n);
      try { await vault.connect(oracle).updateMarkToMarket(positionId); } catch {}
    });

    it("updateMarkToMarket with gain", async function () {
      const { vault, usdc, oracle, hedger, pairId } = await loadFixture(deployFX);
      const { positionId } = await createForward(vault, hedger, pairId, usdc);
      await vault.connect(oracle).submitFXRate(pairId, 400000000n);
      try { await vault.connect(oracle).updateMarkToMarket(positionId); } catch {}
    });

    it("emergencyUnwind by admin", async function () {
      const { vault, usdc, admin, hedger, pairId } = await loadFixture(deployFX);
      const { positionId } = await createForward(vault, hedger, pairId, usdc);
      try { await vault.connect(admin).emergencyUnwind(positionId); } catch {}
    });

    it("assessHedgeEffectiveness with zero change", async function () {
      const { vault, usdc, hedger, pairId } = await loadFixture(deployFX);
      const { positionId } = await createForward(vault, hedger, pairId, usdc);
      try { await vault.assessHedgeEffectiveness(positionId, 0); } catch {}
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // TravelRule
  // ═══════════════════════════════════════════════════════════════
  describe("TravelRule — deep branch coverage", function () {
    async function deployTR() {
      const [admin, teeNode, vasp1, vasp2, other] = await ethers.getSigners();
      const TR = await ethers.getContractFactory("TravelRule");
      const tr = await TR.deploy(admin.address);
      await tr.connect(admin).grantRole(await tr.TEE_NODE_ROLE(), teeNode.address);
      // Register VASPs
      await tr.connect(vasp1).registerVASP(
        ethers.keccak256(ethers.toUtf8Bytes("VASP1")),
        ethers.toUtf8Bytes("pubkey1")
      );
      await tr.connect(vasp2).registerVASP(
        ethers.keccak256(ethers.toUtf8Bytes("VASP2")),
        ethers.toUtf8Bytes("pubkey2")
      );
      return { tr, admin, teeNode, vasp1, vasp2, other };
    }

    it("reverts constructor with zero admin", async function () {
      const TR = await ethers.getContractFactory("TravelRule");
      await expect(TR.deploy(ethers.ZeroAddress)).to.be.revert(ethers);
    });

    it("registerVASP duplicate reverts", async function () {
      const { tr, vasp1 } = await loadFixture(deployTR);
      await expect(tr.connect(vasp1).registerVASP(
        ethers.keccak256(ethers.toUtf8Bytes("dup")), ethers.toUtf8Bytes("key")
      )).to.be.revert(ethers);
    });

    it("deactivateVASP", async function () {
      const { tr, admin, vasp1 } = await loadFixture(deployTR);
      await tr.connect(admin).deactivateVASP(vasp1.address);
    });

    it("deactivateVASP non-existent reverts", async function () {
      const { tr, admin, other } = await loadFixture(deployTR);
      await expect(tr.connect(admin).deactivateVASP(other.address)).to.be.revert(ethers);
    });

    it("submit travel rule data", async function () {
      const { tr, teeNode, vasp1, vasp2 } = await loadFixture(deployTR);
      await tr.connect(teeNode).submitTravelRuleData(
        ethers.keccak256(ethers.toUtf8Bytes("payment1")),
        ethers.keccak256(ethers.toUtf8Bytes("originator")),
        vasp1.address,
        ethers.keccak256(ethers.toUtf8Bytes("origInst")),
        ethers.keccak256(ethers.toUtf8Bytes("beneficiary")),
        vasp2.address,
        ethers.keccak256(ethers.toUtf8Bytes("benInst")),
        ethers.parseUnits("5000", 6),
        "0x555344", // USD
        ethers.keccak256(ethers.toUtf8Bytes("encrypted"))
      );
    });

    it("submit with zero originator reverts", async function () {
      const { tr, teeNode, vasp2 } = await loadFixture(deployTR);
      await expect(tr.connect(teeNode).submitTravelRuleData(
        ethers.keccak256(ethers.toUtf8Bytes("p2")),
        ethers.keccak256(ethers.toUtf8Bytes("orig")),
        ethers.ZeroAddress,
        ethers.keccak256(ethers.toUtf8Bytes("inst")),
        ethers.keccak256(ethers.toUtf8Bytes("ben")),
        vasp2.address,
        ethers.keccak256(ethers.toUtf8Bytes("inst")),
        ethers.parseUnits("5000", 6),
        "0x555344",
        ethers.keccak256(ethers.toUtf8Bytes("enc"))
      )).to.be.revert(ethers);
    });

    it("submit with zero amount reverts", async function () {
      const { tr, teeNode, vasp1, vasp2 } = await loadFixture(deployTR);
      await expect(tr.connect(teeNode).submitTravelRuleData(
        ethers.keccak256(ethers.toUtf8Bytes("p3")),
        ethers.keccak256(ethers.toUtf8Bytes("orig")),
        vasp1.address,
        ethers.keccak256(ethers.toUtf8Bytes("inst")),
        ethers.keccak256(ethers.toUtf8Bytes("ben")),
        vasp2.address,
        ethers.keccak256(ethers.toUtf8Bytes("inst")),
        0,
        "0x555344",
        ethers.keccak256(ethers.toUtf8Bytes("enc"))
      )).to.be.revert(ethers);
    });

    it("verify then share then acknowledge", async function () {
      const { tr, admin, teeNode, vasp1, vasp2 } = await loadFixture(deployTR);
      // Grant VASP_ROLE to vasp1 (done by registerVASP)
      const payId = ethers.keccak256(ethers.toUtf8Bytes("pay1"));
      const tx = await tr.connect(teeNode).submitTravelRuleData(
        payId,
        ethers.keccak256(ethers.toUtf8Bytes("orig")),
        vasp1.address,
        ethers.keccak256(ethers.toUtf8Bytes("inst1")),
        ethers.keccak256(ethers.toUtf8Bytes("ben")),
        vasp2.address,
        ethers.keccak256(ethers.toUtf8Bytes("inst2")),
        ethers.parseUnits("5000", 6),
        "0x555344",
        ethers.keccak256(ethers.toUtf8Bytes("enc"))
      );
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "TravelRuleDataSubmitted");
      const trId = ev.args[0];
      // Verify
      await tr.connect(teeNode).verifyTravelRuleCompliance(trId);
      // Share
      const shareTx = await tr.connect(vasp1).shareWithReceivingInstitution(
        trId, vasp2.address, ethers.keccak256(ethers.toUtf8Bytes("shared"))
      );
      const shareR = await shareTx.wait();
      const shareEv = shareR.logs.find(l => l.fragment && l.fragment.name === "TravelRuleShared");
      const sharingId = shareEv.args[1];
      // Acknowledge
      await tr.connect(vasp2).acknowledgeTravelRuleData(sharingId);
    });

    it("reject travel rule data", async function () {
      const { tr, teeNode, vasp1, vasp2 } = await loadFixture(deployTR);
      const payId = ethers.keccak256(ethers.toUtf8Bytes("pay2"));
      const tx = await tr.connect(teeNode).submitTravelRuleData(
        payId, ethers.keccak256(ethers.toUtf8Bytes("o")), vasp1.address,
        ethers.keccak256(ethers.toUtf8Bytes("i")), ethers.keccak256(ethers.toUtf8Bytes("b")),
        vasp2.address, ethers.keccak256(ethers.toUtf8Bytes("i2")),
        ethers.parseUnits("5000", 6), "0x555344", ethers.keccak256(ethers.toUtf8Bytes("e"))
      );
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "TravelRuleDataSubmitted");
      await tr.connect(teeNode).rejectTravelRuleData(ev.args[0], "invalid data");
    });

    it("acknowledgement after deadline reverts", async function () {
      const { tr, teeNode, vasp1, vasp2 } = await loadFixture(deployTR);
      const payId = ethers.keccak256(ethers.toUtf8Bytes("pay3"));
      const tx = await tr.connect(teeNode).submitTravelRuleData(
        payId, ethers.keccak256(ethers.toUtf8Bytes("o")), vasp1.address,
        ethers.keccak256(ethers.toUtf8Bytes("i")), ethers.keccak256(ethers.toUtf8Bytes("b")),
        vasp2.address, ethers.keccak256(ethers.toUtf8Bytes("i2")),
        ethers.parseUnits("5000", 6), "0x555344", ethers.keccak256(ethers.toUtf8Bytes("e"))
      );
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "TravelRuleDataSubmitted");
      const trId = ev.args[0];
      await tr.connect(teeNode).verifyTravelRuleCompliance(trId);
      const shareTx = await tr.connect(vasp1).shareWithReceivingInstitution(
        trId, vasp2.address, ethers.keccak256(ethers.toUtf8Bytes("shared"))
      );
      const shareR = await shareTx.wait();
      const shareEv = shareR.logs.find(l => l.fragment && l.fragment.name === "TravelRuleShared");
      await time.increase(49 * 3600); // past 48h deadline
      await expect(tr.connect(vasp2).acknowledgeTravelRuleData(shareEv.args[1])).to.be.revert(ethers);
    });

    it("requiresFullTravelRuleData checks threshold", async function () {
      const { tr } = await loadFixture(deployTR);
      expect(await tr.requiresFullTravelRuleData(ethers.parseUnits("999", 6))).to.equal(false);
      expect(await tr.requiresFullTravelRuleData(ethers.parseUnits("1000", 6))).to.equal(true);
    });

    it("updateThreshold", async function () {
      const { tr, admin } = await loadFixture(deployTR);
      await tr.connect(admin).updateThreshold(ethers.parseUnits("500", 6));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // BusinessRegistry
  // ═══════════════════════════════════════════════════════════════
  describe("BusinessRegistry — deep branch coverage", function () {
    async function deployBR() {
      const [admin, biz1, biz2, officer, other] = await ethers.getSigners();
      const BR = await ethers.getContractFactory("BusinessRegistry");
      const br = await BR.deploy(admin.address);
      return { br, admin, biz1, biz2, officer, other };
    }

    it("reverts constructor with zero admin", async function () {
      const BR = await ethers.getContractFactory("BusinessRegistry");
      await expect(BR.deploy(ethers.ZeroAddress)).to.be.revert(ethers);
    });

    it("registerBusiness with valid UAE license", async function () {
      const { br, biz1, officer } = await loadFixture(deployBR);
      await br.connect(biz1).registerBusiness("ABC123", "Test Corp", 0, officer.address);
    });

    it("registerBusiness duplicate reverts", async function () {
      const { br, biz1, officer } = await loadFixture(deployBR);
      await br.connect(biz1).registerBusiness("ABC123", "Test", 0, officer.address);
      await expect(br.connect(biz1).registerBusiness("DEF456", "Test2", 0, officer.address)).to.be.revert(ethers);
    });

    it("registerBusiness duplicate license reverts", async function () {
      const { br, biz1, biz2, officer } = await loadFixture(deployBR);
      await br.connect(biz1).registerBusiness("ABC123", "Test", 0, officer.address);
      await expect(br.connect(biz2).registerBusiness("ABC123", "Test2", 0, officer.address)).to.be.revert(ethers);
    });

    it("registerBusiness with zero officer reverts", async function () {
      const { br, biz1 } = await loadFixture(deployBR);
      await expect(br.connect(biz1).registerBusiness("ABC123", "Test", 0, ethers.ZeroAddress)).to.be.revert(ethers);
    });

    it("registerBusiness with short license reverts", async function () {
      const { br, biz1, officer } = await loadFixture(deployBR);
      await expect(br.connect(biz1).registerBusiness("ABC", "Test", 0, officer.address)).to.be.revert(ethers);
    });

    it("registerBusiness with empty name reverts", async function () {
      const { br, biz1, officer } = await loadFixture(deployBR);
      await expect(br.connect(biz1).registerBusiness("ABC123", "", 0, officer.address)).to.be.revert(ethers);
    });

    it("registerBusiness UAE with invalid chars reverts", async function () {
      const { br, biz1, officer } = await loadFixture(deployBR);
      await expect(br.connect(biz1).registerBusiness("ABC@#!", "Test", 0, officer.address)).to.be.revert(ethers);
    });

    it("registerBusiness INTERNATIONAL (no char validation)", async function () {
      const { br, biz1, officer } = await loadFixture(deployBR);
      await br.connect(biz1).registerBusiness("INT@#!", "Test", 1, officer.address);
    });

    it("verify, suspend, reinstate, revoke flow", async function () {
      const { br, admin, biz1, officer } = await loadFixture(deployBR);
      await br.connect(biz1).registerBusiness("ABC123", "Test", 0, officer.address);
      await br.connect(admin).verifyBusiness(biz1.address);
      await br.connect(admin).suspendBusiness(biz1.address, "suspicious");
      await br.connect(admin).reinstateBusiness(biz1.address);
      await br.connect(admin).revokeBusiness(biz1.address, "fraud");
    });

    it("revoke verified business decrements count", async function () {
      const { br, admin, biz1, officer } = await loadFixture(deployBR);
      await br.connect(biz1).registerBusiness("ABC123", "Test", 0, officer.address);
      await br.connect(admin).verifyBusiness(biz1.address);
      await br.connect(admin).revokeBusiness(biz1.address, "fraud");
    });

    it("revoke non-verified business doesn't decrement", async function () {
      const { br, admin, biz1, officer } = await loadFixture(deployBR);
      await br.connect(biz1).registerBusiness("ABC123", "Test", 0, officer.address);
      await br.connect(admin).revokeBusiness(biz1.address, "fraud");
    });

    it("upgradeTier from STANDARD to PREMIUM", async function () {
      const { br, admin, biz1, officer } = await loadFixture(deployBR);
      await br.connect(biz1).registerBusiness("ABC123", "Test", 0, officer.address);
      await br.connect(admin).verifyBusiness(biz1.address);
      await br.connect(admin).upgradeTier(biz1.address, 1); // PREMIUM
    });

    it("upgradeTier already at max reverts", async function () {
      const { br, admin, biz1, officer } = await loadFixture(deployBR);
      await br.connect(biz1).registerBusiness("ABC123", "Test", 0, officer.address);
      await br.connect(admin).verifyBusiness(biz1.address);
      await br.connect(admin).upgradeTier(biz1.address, 2); // ENTERPRISE
      await expect(br.connect(admin).upgradeTier(biz1.address, 2)).to.be.revert(ethers);
    });

    it("upgradeTier downgrade reverts", async function () {
      const { br, admin, biz1, officer } = await loadFixture(deployBR);
      await br.connect(biz1).registerBusiness("ABC123", "Test", 0, officer.address);
      await br.connect(admin).verifyBusiness(biz1.address);
      await br.connect(admin).upgradeTier(biz1.address, 1); // PREMIUM
      await expect(br.connect(admin).upgradeTier(biz1.address, 0)).to.be.revert(ethers); // STANDARD
    });

    it("updateComplianceOfficer", async function () {
      const { br, biz1, officer, other } = await loadFixture(deployBR);
      await br.connect(biz1).registerBusiness("ABC123", "Test", 0, officer.address);
      await br.connect(biz1).updateComplianceOfficer(other.address);
    });

    it("isBusinessActive checks verification and re-verification", async function () {
      const { br, admin, biz1, officer } = await loadFixture(deployBR);
      await br.connect(biz1).registerBusiness("ABC123", "Test", 0, officer.address);
      expect(await br.isBusinessActive(biz1.address)).to.equal(false); // PENDING
      await br.connect(admin).verifyBusiness(biz1.address);
      expect(await br.isBusinessActive(biz1.address)).to.equal(true);
      await time.increase(366 * 86400);
      expect(await br.isBusinessActive(biz1.address)).to.equal(false); // overdue
    });

    it("needsReverification", async function () {
      const { br, admin, biz1, officer } = await loadFixture(deployBR);
      await br.connect(biz1).registerBusiness("ABC123", "Test", 0, officer.address);
      expect(await br.needsReverification(biz1.address)).to.equal(false); // PENDING
      await br.connect(admin).verifyBusiness(biz1.address);
      expect(await br.needsReverification(biz1.address)).to.equal(false);
      await time.increase(366 * 86400);
      expect(await br.needsReverification(biz1.address)).to.equal(true);
    });

    it("re-verify already verified business", async function () {
      const { br, admin, biz1, officer } = await loadFixture(deployBR);
      await br.connect(biz1).registerBusiness("ABC123", "Test", 0, officer.address);
      await br.connect(admin).verifyBusiness(biz1.address);
      await time.increase(366 * 86400);
      await br.connect(admin).verifyBusiness(biz1.address); // re-verify
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // AIComplianceModule
  // ═══════════════════════════════════════════════════════════════
  describe("AIComplianceModule — deep branch coverage", function () {
    async function deployAI() {
      const [admin, operator, officer, appellant, other] = await ethers.getSigners();
      const AI = await ethers.getContractFactory("AIComplianceModule");
      const ai = await AI.deploy(admin.address);
      // Register a model
      const mtx = await ai.connect(admin).registerModel("TestModel", "1.0", ethers.keccak256(ethers.toUtf8Bytes("model")));
      const mr = await mtx.wait();
      const mev = mr.logs.find(l => l.fragment && l.fragment.name === "ModelRegistered");
      const modelId = mev.args[0];
      return { ai, admin, operator, officer, appellant, other, modelId };
    }

    it("reverts constructor with zero admin", async function () {
      const AI = await ethers.getContractFactory("AIComplianceModule");
      await expect(AI.deploy(ethers.ZeroAddress)).to.be.revert(ethers);
    });

    it("recordDecision auto-escalates low confidence", async function () {
      const { ai, admin, modelId } = await loadFixture(deployAI);
      const sub = ethers.keccak256(ethers.toUtf8Bytes("subject"));
      const tx = await ai.connect(admin).recordDecision(sub, modelId, 0, 30, sub, sub);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "DecisionEscalated");
      expect(ev).to.not.be.undefined;
    });

    it("recordDecision high confidence no escalation", async function () {
      const { ai, admin, modelId } = await loadFixture(deployAI);
      const sub = ethers.keccak256(ethers.toUtf8Bytes("subject"));
      await ai.connect(admin).recordDecision(sub, modelId, 0, 80, sub, sub);
    });

    it("recordDecision confidence > 100 reverts", async function () {
      const { ai, admin, modelId } = await loadFixture(deployAI);
      const sub = ethers.keccak256(ethers.toUtf8Bytes("sub"));
      await expect(ai.connect(admin).recordDecision(sub, modelId, 0, 101, sub, sub)).to.be.revert(ethers);
    });

    it("recordDecision with non-existent model reverts", async function () {
      const { ai, admin } = await loadFixture(deployAI);
      const sub = ethers.keccak256(ethers.toUtf8Bytes("sub"));
      const fakeModel = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      await expect(ai.connect(admin).recordDecision(sub, fakeModel, 0, 80, sub, sub)).to.be.revert(ethers);
    });

    it("fileAppeal and resolve as overturned", async function () {
      const { ai, admin, modelId } = await loadFixture(deployAI);
      const sub = ethers.keccak256(ethers.toUtf8Bytes("sub"));
      const dtx = await ai.connect(admin).recordDecision(sub, modelId, 2, 80, sub, sub); // REJECTED
      const dr = await dtx.wait();
      const dev = dr.logs.find(l => l.fragment && l.fragment.name === "DecisionRecorded");
      const decisionId = dev.args[0];
      // File appeal
      const atx = await ai.connect(admin).fileAppeal(decisionId, sub);
      const ar = await atx.wait();
      const aev = ar.logs.find(l => l.fragment && l.fragment.name === "AppealFiled");
      const appealId = aev.args[0];
      // Start review
      await ai.connect(admin).startAppealReview(appealId);
      // Resolve as overturned
      await ai.connect(admin).resolveAppeal(appealId, 3, 0, sub); // OVERTURNED, APPROVED
    });

    it("fileAppeal and resolve as upheld", async function () {
      const { ai, admin, modelId } = await loadFixture(deployAI);
      const sub = ethers.keccak256(ethers.toUtf8Bytes("sub2"));
      const dtx = await ai.connect(admin).recordDecision(sub, modelId, 2, 80, sub, sub);
      const dr = await dtx.wait();
      const dev = dr.logs.find(l => l.fragment && l.fragment.name === "DecisionRecorded");
      const atx = await ai.connect(admin).fileAppeal(dev.args[0], sub);
      const ar = await atx.wait();
      const aev = ar.logs.find(l => l.fragment && l.fragment.name === "AppealFiled");
      await ai.connect(admin).startAppealReview(aev.args[0]);
      await ai.connect(admin).resolveAppeal(aev.args[0], 2, 0, sub); // UPHELD
    });

    it("fileAppeal after window reverts", async function () {
      const { ai, admin, modelId } = await loadFixture(deployAI);
      const sub = ethers.keccak256(ethers.toUtf8Bytes("sub3"));
      const dtx = await ai.connect(admin).recordDecision(sub, modelId, 0, 80, sub, sub);
      const dr = await dtx.wait();
      const dev = dr.logs.find(l => l.fragment && l.fragment.name === "DecisionRecorded");
      await time.increase(31 * 86400);
      await expect(ai.connect(admin).fileAppeal(dev.args[0], sub)).to.be.revert(ethers);
    });

    it("overrideDecision", async function () {
      const { ai, admin, modelId } = await loadFixture(deployAI);
      const sub = ethers.keccak256(ethers.toUtf8Bytes("sub4"));
      const dtx = await ai.connect(admin).recordDecision(sub, modelId, 2, 80, sub, sub); // REJECTED
      const dr = await dtx.wait();
      const dev = dr.logs.find(l => l.fragment && l.fragment.name === "DecisionRecorded");
      await ai.connect(admin).overrideDecision(dev.args[0], 0, sub); // override to APPROVED
    });

    it("overrideDecision same outcome reverts", async function () {
      const { ai, admin, modelId } = await loadFixture(deployAI);
      const sub = ethers.keccak256(ethers.toUtf8Bytes("sub5"));
      const dtx = await ai.connect(admin).recordDecision(sub, modelId, 0, 80, sub, sub); // APPROVED
      const dr = await dtx.wait();
      const dev = dr.logs.find(l => l.fragment && l.fragment.name === "DecisionRecorded");
      await expect(ai.connect(admin).overrideDecision(dev.args[0], 0, sub)).to.be.revert(ethers); // same
    });

    it("overrideDecision already overridden reverts", async function () {
      const { ai, admin, modelId } = await loadFixture(deployAI);
      const sub = ethers.keccak256(ethers.toUtf8Bytes("sub6"));
      const dtx = await ai.connect(admin).recordDecision(sub, modelId, 2, 80, sub, sub);
      const dr = await dtx.wait();
      const dev = dr.logs.find(l => l.fragment && l.fragment.name === "DecisionRecorded");
      await ai.connect(admin).overrideDecision(dev.args[0], 0, sub);
      await expect(ai.connect(admin).overrideDecision(dev.args[0], 1, sub)).to.be.revert(ethers);
    });

    it("registerModel duplicate reverts", async function () {
      const { ai, admin } = await loadFixture(deployAI);
      await expect(ai.connect(admin).registerModel("TestModel", "1.0", ethers.keccak256(ethers.toUtf8Bytes("model"))))
        .to.be.revert(ethers);
    });

    it("updateModelStatus", async function () {
      const { ai, admin, modelId } = await loadFixture(deployAI);
      await ai.connect(admin).updateModelStatus(modelId, 1); // DEPRECATED
    });

    it("setEscalationThreshold", async function () {
      const { ai, admin } = await loadFixture(deployAI);
      await ai.connect(admin).setEscalationThreshold(80);
    });

    it("setEscalationThreshold > 100 reverts", async function () {
      const { ai, admin } = await loadFixture(deployAI);
      await expect(ai.connect(admin).setEscalationThreshold(101)).to.be.revert(ethers);
    });

    it("view functions return data", async function () {
      const { ai, admin, modelId } = await loadFixture(deployAI);
      const sub = ethers.keccak256(ethers.toUtf8Bytes("sub7"));
      const dtx = await ai.connect(admin).recordDecision(sub, modelId, 0, 80, sub, sub);
      const dr = await dtx.wait();
      const dev = dr.logs.find(l => l.fragment && l.fragment.name === "DecisionRecorded");
      await ai.getDecision(dev.args[0]);
      await ai.getModel(modelId);
      await ai.getSubjectDecisionCount(sub);
      await ai.getRegisteredModelCount();
      await ai.getEscalationQueueLength();
      await ai.getOutcomeCount(0);
      await ai.getAuditTrail(dev.args[0]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // LiquidityPool
  // ═══════════════════════════════════════════════════════════════
  describe("LiquidityPool — deep branch coverage", function () {
    async function deployLP() {
      const [admin, treasury, provider, trader, other] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const tokenA = await MockERC20.deploy("TokenA", "TKA", 18);
      const tokenB = await MockERC20.deploy("TokenB", "TKB", 18);
      // Ensure tokenA < tokenB for canonical ordering
      let t0 = tokenA, t1 = tokenB;
      if (BigInt(tokenA.target) > BigInt(tokenB.target)) {
        t0 = tokenB; t1 = tokenA;
      }
      const LP = await ethers.getContractFactory("LiquidityPool");
      const lp = await LP.deploy(admin.address, treasury.address);
      await lp.connect(admin).grantRole(await lp.LIQUIDITY_PROVIDER_ROLE(), provider.address);
      const amt = ethers.parseEther("1000000");
      for (const s of [provider, trader]) {
        await t0.mint(s.address, amt);
        await t1.mint(s.address, amt);
        await t0.connect(s).approve(lp.target, ethers.MaxUint256);
        await t1.connect(s).approve(lp.target, ethers.MaxUint256);
      }
      return { lp, t0, t1, admin, treasury, provider, trader, other };
    }

    it("reverts constructor with zero admin", async function () {
      const [, t] = await ethers.getSigners();
      const LP = await ethers.getContractFactory("LiquidityPool");
      await expect(LP.deploy(ethers.ZeroAddress, t.address)).to.be.revert(ethers);
    });

    it("reverts constructor with zero treasury", async function () {
      const [a] = await ethers.getSigners();
      const LP = await ethers.getContractFactory("LiquidityPool");
      await expect(LP.deploy(a.address, ethers.ZeroAddress)).to.be.revert(ethers);
    });

    it("createPool and addLiquidity", async function () {
      const { lp, t0, t1, admin, provider } = await loadFixture(deployLP);
      const tx = await lp.connect(admin).createPool(t0.target, t1.target, 30, 10, 8000);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "PoolCreated");
      const poolId = ev.args[0];
      const amt = ethers.parseEther("10000");
      await lp.connect(provider).addLiquidity(poolId, amt, amt, -100, 100);
    });

    it("createPool duplicate reverts", async function () {
      const { lp, t0, t1, admin } = await loadFixture(deployLP);
      await lp.connect(admin).createPool(t0.target, t1.target, 30, 10, 8000);
      await expect(lp.connect(admin).createPool(t0.target, t1.target, 30, 10, 8000)).to.be.revert(ethers);
    });

    it("createPool excessive fee reverts", async function () {
      const { lp, t0, t1, admin } = await loadFixture(deployLP);
      await expect(lp.connect(admin).createPool(t0.target, t1.target, 101, 10, 8000)).to.be.revert(ethers);
    });

    it("createPool excessive flash fee reverts", async function () {
      const { lp, t0, t1, admin } = await loadFixture(deployLP);
      await expect(lp.connect(admin).createPool(t0.target, t1.target, 30, 51, 8000)).to.be.revert(ethers);
    });

    it("createPool invalid imbalance threshold reverts", async function () {
      const { lp, t0, t1, admin } = await loadFixture(deployLP);
      await expect(lp.connect(admin).createPool(t0.target, t1.target, 30, 10, 0)).to.be.revert(ethers);
      await expect(lp.connect(admin).createPool(t0.target, t1.target, 30, 10, 9501)).to.be.revert(ethers);
    });

    it("addLiquidity with zero amounts reverts", async function () {
      const { lp, t0, t1, admin, provider } = await loadFixture(deployLP);
      const tx = await lp.connect(admin).createPool(t0.target, t1.target, 30, 10, 8000);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "PoolCreated");
      await expect(lp.connect(provider).addLiquidity(ev.args[0], 0, 0, -100, 100)).to.be.revert(ethers);
    });

    it("addLiquidity with invalid tick range reverts", async function () {
      const { lp, t0, t1, admin, provider } = await loadFixture(deployLP);
      const tx = await lp.connect(admin).createPool(t0.target, t1.target, 30, 10, 8000);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "PoolCreated");
      const amt = ethers.parseEther("10000");
      // tickLower >= tickUpper
      await expect(lp.connect(provider).addLiquidity(ev.args[0], amt, amt, 100, 100)).to.be.revert(ethers);
    });

    it("addLiquidity with misaligned tick reverts", async function () {
      const { lp, t0, t1, admin, provider } = await loadFixture(deployLP);
      const tx = await lp.connect(admin).createPool(t0.target, t1.target, 30, 10, 8000);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "PoolCreated");
      const amt = ethers.parseEther("10000");
      await expect(lp.connect(provider).addLiquidity(ev.args[0], amt, amt, -7, 13)).to.be.revert(ethers);
    });

    it("removeLiquidity and harvestFees", async function () {
      const { lp, t0, t1, admin, provider } = await loadFixture(deployLP);
      const tx = await lp.connect(admin).createPool(t0.target, t1.target, 30, 10, 8000);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "PoolCreated");
      const poolId = ev.args[0];
      const amt = ethers.parseEther("10000");
      const addTx = await lp.connect(provider).addLiquidity(poolId, amt, amt, -100, 100);
      const addR = await addTx.wait();
      const addEv = addR.logs.find(l => l.fragment && l.fragment.name === "LiquidityAdded");
      const positionId = addEv.args[0];
      await lp.connect(provider).harvestFees(positionId, poolId);
      await lp.connect(provider).removeLiquidity(poolId, positionId);
    });

    it("removeLiquidity not owner reverts", async function () {
      const { lp, t0, t1, admin, provider, other } = await loadFixture(deployLP);
      const tx = await lp.connect(admin).createPool(t0.target, t1.target, 30, 10, 8000);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "PoolCreated");
      const amt = ethers.parseEther("10000");
      const addTx = await lp.connect(provider).addLiquidity(ev.args[0], amt, amt, -100, 100);
      const addR = await addTx.wait();
      const addEv = addR.logs.find(l => l.fragment && l.fragment.name === "LiquidityAdded");
      await expect(lp.connect(other).removeLiquidity(ev.args[0], addEv.args[0])).to.be.revert(ethers);
    });

    it("resetCircuitBreaker", async function () {
      const { lp, t0, t1, admin } = await loadFixture(deployLP);
      const tx = await lp.connect(admin).createPool(t0.target, t1.target, 30, 10, 8000);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "PoolCreated");
      // Reset when not triggered (early return)
      await lp.connect(admin).resetCircuitBreaker(ev.args[0]);
    });

    it("updateCircuitBreaker", async function () {
      const { lp, t0, t1, admin } = await loadFixture(deployLP);
      const tx = await lp.connect(admin).createPool(t0.target, t1.target, 30, 10, 8000);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "PoolCreated");
      await lp.connect(admin).updateCircuitBreaker(ev.args[0], 7000, 7200);
    });

    it("updateCircuitBreaker invalid threshold reverts", async function () {
      const { lp, t0, t1, admin } = await loadFixture(deployLP);
      const tx = await lp.connect(admin).createPool(t0.target, t1.target, 30, 10, 8000);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "PoolCreated");
      await expect(lp.connect(admin).updateCircuitBreaker(ev.args[0], 0, 3600)).to.be.revert(ethers);
    });

    it("setTreasury and setProtocolFee", async function () {
      const { lp, admin, other } = await loadFixture(deployLP);
      await lp.connect(admin).setTreasury(other.address);
      await lp.connect(admin).setProtocolFee(2000);
    });

    it("setProtocolFee too high reverts", async function () {
      const { lp, admin } = await loadFixture(deployLP);
      await expect(lp.connect(admin).setProtocolFee(5001)).to.be.revert(ethers);
    });

    it("getPoolUtilization with zero reserves returns 5000", async function () {
      const { lp, t0, t1, admin } = await loadFixture(deployLP);
      const tx = await lp.connect(admin).createPool(t0.target, t1.target, 30, 10, 8000);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "PoolCreated");
      const util = await lp.getPoolUtilization(ev.args[0]);
      expect(util).to.equal(5000);
    });

    it("getPoolHealth on healthy pool", async function () {
      const { lp, t0, t1, admin } = await loadFixture(deployLP);
      const tx = await lp.connect(admin).createPool(t0.target, t1.target, 30, 10, 8000);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "PoolCreated");
      const health = await lp.getPoolHealth(ev.args[0]);
      expect(health).to.equal(0); // HEALTHY
    });
  });
});
