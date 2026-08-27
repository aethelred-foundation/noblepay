/**
 * Minimal ABIs for contract calls made by the browser.
 *
 * Keep these definitions byte-for-byte compatible with contracts/src. Server
 * receipt reconciliation owns its own event ABI so a browser definition can
 * never weaken backend verification.
 */

export const NOBLEPAY_ABI = [
  {
    name: "initiatePayment",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "_recipient", type: "address" },
      { name: "_amount", type: "uint256" },
      { name: "_token", type: "address" },
      { name: "_purposeHash", type: "bytes32" },
      { name: "_currencyCode", type: "bytes3" },
    ],
    outputs: [{ name: "paymentId", type: "bytes32" }],
  },
  {
    name: "settlePayment",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_paymentId", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "cancelPayment",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_paymentId", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "refundPayment",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_paymentId", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "requestSettlementRecovery",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_paymentId", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "executeSettlementRecovery",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_paymentId", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "settlementRecoveryRequests",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "executeAfter", type: "uint64" },
      { name: "expiresAt", type: "uint64" },
      { name: "requestedBy", type: "address" },
    ],
  },
  {
    name: "hasRole",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const COMPLIANCE_ORACLE_ABI = [
  {
    name: "getRiskThresholds",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "lowMax", type: "uint8" },
      { name: "mediumMax", type: "uint8" },
    ],
  },
] as const;

export const BUSINESS_REGISTRY_ABI = [
  {
    name: "businesses",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [
      { name: "wallet", type: "address" },
      { name: "licenseNumber", type: "string" },
      { name: "businessName", type: "string" },
      { name: "jurisdiction", type: "uint8" },
      { name: "kycStatus", type: "uint8" },
      { name: "tier", type: "uint8" },
      { name: "registeredAt", type: "uint256" },
      { name: "lastVerified", type: "uint256" },
      { name: "complianceOfficer", type: "address" },
    ],
  },
  {
    name: "registerBusiness",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_licenseNumber", type: "string" },
      { name: "_businessName", type: "string" },
      { name: "_jurisdiction", type: "uint8" },
      { name: "_complianceOfficer", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "verifyBusiness",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_business", type: "address" }],
    outputs: [],
  },
  {
    name: "upgradeTier",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_business", type: "address" },
      { name: "_newTier", type: "uint8" },
    ],
    outputs: [],
  },
] as const;
