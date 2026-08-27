#!/usr/bin/env node

import { encodeFunctionData, getAddress, isAddress } from "viem";

import {
  TEE_NODE_ACCOUNT_TYPE,
  normalizeBlockHash,
  validateDeploymentCheckpoint,
} from "./lib/deployment-governance.mjs";
import {
  cliPathOption,
  readSecureJSONFile,
} from "./lib/operator-artifacts.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const checkpointFile = cliPathOption(process.argv, "--checkpoint-file", {
  required: true,
});
const checkpoint = readSecureJSONFile(checkpointFile, "checkpoint file");
const governance = required("ADMIN_ADDRESS");
if (!isAddress(governance) || /^0x0{40}$/iu.test(governance)) {
  throw new Error("ADMIN_ADDRESS must be a nonzero EVM address");
}
const chainIdRaw = required("AETHELRED_CHAIN_ID");
if (
  !/^[1-9][0-9]*$/u.test(chainIdRaw) ||
  !Number.isSafeInteger(Number(chainIdRaw))
) {
  throw new Error("AETHELRED_CHAIN_ID must be a positive safe integer");
}
const deployer = required("DEPLOYER_ADDRESS");
if (!isAddress(deployer) || /^0x0{40}$/iu.test(deployer)) {
  throw new Error("DEPLOYER_ADDRESS must be a nonzero EVM address");
}
const networkAnchorBlock = required("AETHELRED_NETWORK_ANCHOR_BLOCK");
if (!/^(?:0|[1-9][0-9]*)$/u.test(networkAnchorBlock)) {
  throw new Error("AETHELRED_NETWORK_ANCHOR_BLOCK must be an unsigned integer");
}
const networkAnchorHash = normalizeBlockHash(
  required("AETHELRED_NETWORK_ANCHOR_HASH"),
  "AETHELRED_NETWORK_ANCHOR_HASH",
);
if (!/^0x[0-9a-fA-F]{64}$/u.test(checkpoint.configurationDigest ?? "")) {
  throw new Error("checkpoint configuration digest is invalid");
}
validateDeploymentCheckpoint(checkpoint, {
  chainId: Number(chainIdRaw),
  chainEnvironment: required("CHAIN_ENV"),
  networkAnchorBlock,
  networkAnchorHash,
  configurationDigest: checkpoint.configurationDigest,
  deployer: getAddress(deployer),
  teeNodeAccountType: TEE_NODE_ACCOUNT_TYPE,
  requireComplete: true,
});
const gate = checkpoint.contracts?.gate?.address;
if (!isAddress(gate) || /^0x0{40}$/iu.test(gate)) {
  throw new Error("checkpoint does not contain a confirmed gate deployment");
}

const payload = {
  chainId: checkpoint.chainId,
  networkAnchor: {
    blockNumber: checkpoint.networkAnchorBlock,
    blockHash: checkpoint.networkAnchorHash,
  },
  requiredExecutor: getAddress(governance),
  target: getAddress(gate),
  value: "0",
  calldata: encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "acceptOwnership",
        stateMutability: "nonpayable",
        inputs: [],
        outputs: [],
      },
    ],
    functionName: "acceptOwnership",
  }),
  method: "acceptOwnership()",
};

console.log(`GOVERNANCE_ACCEPTANCE_JSON=${JSON.stringify(payload)}`);
console.log(
  "Submit this exact target, zero value, and calldata from ADMIN_ADDRESS through the governed multisig; this command does not broadcast.",
);
