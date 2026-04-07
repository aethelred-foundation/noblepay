import crypto from "crypto";

export function generateOpaqueId(prefix: string, byteLength = 8): string {
  return `${prefix}-${crypto.randomBytes(byteLength).toString("hex")}`;
}

export function generateHexId(byteLength = 32): string {
  return `0x${crypto.randomBytes(byteLength).toString("hex")}`;
}
