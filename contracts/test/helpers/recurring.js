const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

async function configuredSigners(treasury) {
  const addresses = await treasury.getSigners();
  return Promise.all(addresses.map((address) => ethers.getSigner(address)));
}

async function proposeAndApproveRecurringPayment(treasury, args) {
  const signers = await configuredSigners(treasury);
  const proposalTx = await treasury
    .connect(signers[0])
    .proposeRecurringPayment(...args);
  const proposalReceipt = await proposalTx.wait();
  const proposalEvent = proposalReceipt.logs.find(
    (log) => log.fragment?.name === "RecurringAuthorizationProposed",
  );
  if (!proposalEvent) {
    throw new Error("RecurringAuthorizationProposed event missing");
  }

  const authorizationId = proposalEvent.args.authorizationId;
  const authorization = await treasury.recurringAuthorizations(authorizationId);
  for (
    let index = 1;
    index < Number(authorization.requiredApprovals);
    index += 1
  ) {
    await treasury
      .connect(signers[index])
      .approveRecurringPayment(authorizationId);
  }

  return { authorizationId, signers };
}

async function createAuthorizedRecurringPayment(treasury, admin, args) {
  const { authorizationId } = await proposeAndApproveRecurringPayment(
    treasury,
    args,
  );
  const authorization = await treasury.recurringAuthorizations(authorizationId);
  const currentTime = BigInt(await time.latest());
  if (currentTime < authorization.timelockExpiry) {
    await time.increaseTo(authorization.timelockExpiry);
  }

  return treasury.connect(admin).createRecurringPayment(...args);
}

module.exports = {
  createAuthorizedRecurringPayment,
  proposeAndApproveRecurringPayment,
};
