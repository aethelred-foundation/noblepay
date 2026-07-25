const { ethers } = require("hardhat");

const CHANNEL_STATE_TYPES = {
  ChannelState: [
    { name: "channelId", type: "bytes32" },
    { name: "balanceA", type: "uint256" },
    { name: "balanceB", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "stateEpoch", type: "uint256" },
    { name: "stateType", type: "bytes32" },
  ],
};

async function channelStateDomain(paymentChannels, overrides = {}) {
  const network = await ethers.provider.getNetwork();
  return {
    name: "NoblePay PaymentChannels",
    version: "1",
    chainId: network.chainId,
    verifyingContract: await paymentChannels.getAddress(),
    ...overrides,
  };
}

function channelStateValue(
  channelId,
  balanceA,
  balanceB,
  nonce,
  stateEpoch,
  stateType,
) {
  return {
    channelId,
    balanceA,
    balanceB,
    nonce,
    stateEpoch,
    stateType: ethers.id(stateType),
  };
}

async function channelStateEpoch(paymentChannels, channelId, override) {
  if (override !== undefined) return override;
  const channel = await paymentChannels.getChannel(channelId);
  return channel.stateEpoch;
}

async function signChannelState(
  paymentChannels,
  signer,
  channelId,
  balanceA,
  balanceB,
  nonce,
  stateType,
  domainOverrides = {},
  stateEpochOverride,
) {
  const domain = await channelStateDomain(paymentChannels, domainOverrides);
  const stateEpoch = await channelStateEpoch(
    paymentChannels,
    channelId,
    stateEpochOverride,
  );
  const value = channelStateValue(
    channelId,
    balanceA,
    balanceB,
    nonce,
    stateEpoch,
    stateType,
  );
  return signer.signTypedData(domain, CHANNEL_STATE_TYPES, value);
}

async function hashChannelState(
  paymentChannels,
  channelId,
  balanceA,
  balanceB,
  nonce,
  stateType,
  domainOverrides = {},
  stateEpochOverride,
) {
  const domain = await channelStateDomain(paymentChannels, domainOverrides);
  const stateEpoch = await channelStateEpoch(
    paymentChannels,
    channelId,
    stateEpochOverride,
  );
  const value = channelStateValue(
    channelId,
    balanceA,
    balanceB,
    nonce,
    stateEpoch,
    stateType,
  );
  return ethers.TypedDataEncoder.hash(domain, CHANNEL_STATE_TYPES, value);
}

async function configureMockBusinessRegistry(
  paymentChannels,
  admin,
  activeParties = [],
) {
  const Registry = await ethers.getContractFactory("MockBusinessRegistry");
  const registry = await Registry.deploy();
  await paymentChannels
    .connect(admin)
    .configureBusinessRegistry(registry.target);
  for (const party of activeParties) {
    const address = typeof party === "string" ? party : party.address;
    await registry.setBusiness(address, true, 0);
  }
  return registry;
}

module.exports = {
  CHANNEL_STATE_TYPES,
  channelStateDomain,
  channelStateValue,
  signChannelState,
  hashChannelState,
  configureMockBusinessRegistry,
};
