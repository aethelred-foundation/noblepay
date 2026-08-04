export const TESTNET_HTTP_RPC_ACKNOWLEDGEMENT =
  "acknowledge-evaluation-only-plaintext-rpc";

function parseRpcUrl(rpcUrl) {
  let parsed;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new Error("RPC_URL must be an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("RPC_URL must use http or https");
  }
  return parsed;
}

export function validatePrivateRpcTransport({
  chainEnvironment,
  rpcUrl,
  insecureTestnetAcknowledgement = "",
}) {
  const parsed = parseRpcUrl(rpcUrl);
  const acknowledgement = insecureTestnetAcknowledgement.trim();

  if (parsed.protocol === "https:") {
    if (
      acknowledgement &&
      acknowledgement !== "false" &&
      acknowledgement !== TESTNET_HTTP_RPC_ACKNOWLEDGEMENT
    ) {
      throw new Error(
        "ALLOW_INSECURE_TESTNET_RPC contains an unsupported value",
      );
    }
    return {
      rpcUrl: parsed.toString(),
      transportSecurity: "tls",
      evaluationOnly: false,
    };
  }

  if (chainEnvironment === "mainnet") {
    throw new Error("mainnet deployments require an HTTPS RPC_URL");
  }

  if (chainEnvironment === "testnet") {
    if (acknowledgement !== TESTNET_HTTP_RPC_ACKNOWLEDGEMENT) {
      throw new Error(
        `plaintext testnet RPC is evaluation-only; set ALLOW_INSECURE_TESTNET_RPC=${TESTNET_HTTP_RPC_ACKNOWLEDGEMENT} to acknowledge the risk, or use HTTPS`,
      );
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(
        "evaluation-only plaintext RPC_URL must not contain credentials, query parameters, or fragments",
      );
    }
    return {
      rpcUrl: parsed.toString(),
      transportSecurity: "plaintext-evaluation",
      evaluationOnly: true,
    };
  }

  return {
    rpcUrl: parsed.toString(),
    transportSecurity: "development",
    evaluationOnly: true,
  };
}

export function plaintextRpcWarning() {
  return (
    "WARNING: evaluation-only plaintext testnet RPC is enabled. " +
    "Chain ID and immutable anchor checks remain mandatory; do not use this mode for mainnet or production traffic."
  );
}
