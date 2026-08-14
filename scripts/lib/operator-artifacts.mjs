import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

const MAX_OPERATOR_ARTIFACT_BYTES = 2 * 1024 * 1024;

export const FINALIZED_ENVIRONMENT_KEYS = Object.freeze([
  "PUBLIC_ORIGIN",
  "PUBLIC_AETHELRED_RPC_URL",
  "PUBLIC_AETHELRED_WS_URL",
  "PUBLIC_AETHELRED_EXPLORER_URL",
  "NOBLEPAY_CHAIN_ID",
  "AETHELRED_NETWORK_ANCHOR_BLOCK",
  "AETHELRED_NETWORK_ANCHOR_HASH",
  "NOBLEPAY_CONTRACT_ADDRESS",
  "BUSINESS_REGISTRY_CONTRACT_ADDRESS",
  "BUSINESS_VERIFIER_ADDRESS",
  "PAYMENT_CHANNELS_ADDRESS",
  "NOBLEPAY_TOKEN_CONFIG",
  "USDC_TOKEN_ADDRESS",
  "USDT_TOKEN_ADDRESS",
  "NEXT_PUBLIC_CHAIN_ENV",
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_WS_URL",
  "WALLETCONNECT_PROJECT_ID",
  "NEXT_PUBLIC_SENTRY_DSN",
  "NEXT_PUBLIC_APP_VERSION",
  "INDEXER_START_BLOCK",
]);

function requireAbsolutePath(path, label) {
  if (!path || !isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path;
}

/**
 * Two kinds of operator artifact, with different threat models.
 *
 * "secret" — a key file. Disclosure is the whole risk, so nothing outside the
 * owner may read it: mode 0600, parent 0700.
 *
 * "integrity" — an input the script acts on but which contains no secret, such
 * as a governance payload of chain id, block anchor, target address and
 * calldata. All of that is public the moment it is broadcast. What matters is
 * that nobody else can CHANGE it, because rewriting `target` or `calldata`
 * would make this script broadcast a different call than the operator
 * reviewed. So group/other write is refused and group/other read is not.
 *
 * Defaulting to "secret" keeps every existing caller strict; only a call site
 * that has thought about it opts down.
 */
const SENSITIVITY = {
  secret: {
    fileMask: 0o077,
    dirMask: 0o077,
    fileFix: "600",
    dirFix: "700",
    why: "it may be read by others",
  },
  integrity: {
    fileMask: 0o022,
    dirMask: 0o022,
    fileFix: "644",
    dirFix: "755",
    why: "others may change what this script acts on",
  },
};

/** Renders a mode as the four-digit octal an operator would pass to chmod. */
function octal(mode) {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

function permissionError(label, path, stat, kind, sensitivity) {
  const rule = SENSITIVITY[sensitivity];
  return new Error(
    `${label} is too permissive: ${rule.why}.\n` +
      `  ${kind}: ${path}\n` +
      `  mode:  ${octal(stat.mode)} (must not grant ` +
      `${sensitivity === "secret" ? "any group or other access" : "group or other WRITE access"})\n` +
      `  fix:   chmod ${sensitivity === "secret" ? (kind === "directory" ? rule.dirFix : rule.fileFix) : kind === "directory" ? rule.dirFix : rule.fileFix} ${path}`,
  );
}

function secureParentDirectory(path, label, sensitivity = "secret") {
  const parentPath = dirname(requireAbsolutePath(path, label));
  const parent = lstatSync(parentPath);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error(`${label} parent must be a regular directory`);
  }
  if ((parent.mode & SENSITIVITY[sensitivity].dirMask) !== 0) {
    throw permissionError(
      `${label} parent directory`,
      parentPath,
      parent,
      "directory",
      sensitivity,
    );
  }
  return parentPath;
}

function fsyncParentDirectory(path, label) {
  const parentPath = secureParentDirectory(path, label);
  const descriptor = openSync(parentPath, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function cliPathOption(argv, name, { required = false } = {}) {
  const values = [];
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === name) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${name} requires an absolute path`);
      }
      values.push(value);
      index += 1;
    } else if (argument.startsWith(`${name}=`)) {
      values.push(argument.slice(name.length + 1));
    }
  }
  if (values.length > 1) {
    throw new Error(`${name} must be provided at most once`);
  }
  if (required && values.length === 0) {
    throw new Error(`${name} is required`);
  }
  return values.length === 0 ? null : requireAbsolutePath(values[0], name);
}

function secureFileStat(
  path,
  label,
  { allowMissing = false, sensitivity = "secret" } = {},
) {
  requireAbsolutePath(path, label);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a symlink`);
  }
  if ((stat.mode & SENSITIVITY[sensitivity].fileMask) !== 0) {
    throw permissionError(label, path, stat, "file", sensitivity);
  }
  if (stat.size > MAX_OPERATOR_ARTIFACT_BYTES) {
    throw new Error(`${label} exceeds the 2 MiB operator-artifact limit`);
  }
  return stat;
}

export function assertNewSecureArtifactPath(path, label) {
  secureParentDirectory(path, label);
  const existing = secureFileStat(path, label, { allowMissing: true });
  if (existing) {
    throw new Error(`${label} already exists; choose a new archive path`);
  }
}

export function readSecureJSONFile(
  path,
  label,
  { allowMissing = false, sensitivity = "secret" } = {},
) {
  secureParentDirectory(path, label, sensitivity);
  const stat = secureFileStat(path, label, { allowMissing, sensitivity });
  if (!stat) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value;
}

export function writeSecureJSONFile(path, value, label) {
  secureParentDirectory(path, label);
  secureFileStat(path, label, { allowMissing: true });

  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  let descriptor;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    chmodSync(temporaryPath, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    fsyncParentDirectory(path, label);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function parseJSONEnvironmentValue(raw, label) {
  if (!raw?.trim()) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value;
}

export function loadCheckpointArtifact({ checkpointFile, environmentValue }) {
  const fromFile = checkpointFile
    ? readSecureJSONFile(checkpointFile, "checkpoint file", {
        allowMissing: true,
      })
    : null;
  const fromEnvironment = parseJSONEnvironmentValue(
    environmentValue,
    "BOOTSTRAP_CHECKPOINT_JSON",
  );
  if (
    fromFile &&
    fromEnvironment &&
    !isDeepStrictEqual(fromFile, fromEnvironment)
  ) {
    throw new Error(
      "checkpoint file and BOOTSTRAP_CHECKPOINT_JSON contain different ceremony state",
    );
  }
  return fromFile ?? fromEnvironment;
}

export function validateFinalizedEnvironment(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error(
      "deployment manifest applicationEnvironment must be an object",
    );
  }
  const actualKeys = Object.keys(values).sort();
  const expectedKeys = [...FINALIZED_ENVIRONMENT_KEYS].sort();
  if (!isDeepStrictEqual(actualKeys, expectedKeys)) {
    throw new Error(
      "deployment manifest applicationEnvironment does not contain the exact release-derived keys",
    );
  }
  for (const [key, value] of Object.entries(values)) {
    if (
      typeof value !== "string" ||
      value.trim() !== value ||
      value.includes("\n") ||
      value.includes("\r") ||
      value.includes("\0") ||
      value.includes("$") ||
      value.includes("#") ||
      value.includes("\\") ||
      value.startsWith('"') ||
      value.startsWith("'")
    ) {
      throw new Error(`${key} is not a safe unquoted environment value`);
    }
  }
  return values;
}

export function applyFinalizedEnvironment(envText, values) {
  validateFinalizedEnvironment(values);
  const lines = envText.split(/\r?\n/u);
  const indexes = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(lines[index]);
    if (!match) continue;
    if (indexes.has(match[1])) {
      throw new Error(`environment file contains duplicate ${match[1]}`);
    }
    indexes.set(match[1], index);
  }
  for (const key of FINALIZED_ENVIRONMENT_KEYS) {
    const index = indexes.get(key);
    if (index === undefined) {
      throw new Error(`environment file is missing release-derived key ${key}`);
    }
    lines[index] = `${key}=${values[key]}`;
  }
  return lines.join("\n");
}

export function applyFinalizedEnvironmentFile(path, values) {
  secureParentDirectory(path, "production environment file");
  secureFileStat(path, "production environment file");
  const updated = applyFinalizedEnvironment(readFileSync(path, "utf8"), values);
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  let descriptor;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeFileSync(descriptor, updated, "utf8");
    chmodSync(temporaryPath, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    fsyncParentDirectory(path, "production environment file");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
