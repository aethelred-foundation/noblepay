export const DEFAULT_EXTERNAL_JSON_LIMIT_BYTES = 1024 * 1024;

/** Read a Fetch response without ever retaining more than the configured bytes. */
export async function readBoundedResponseText(
  response: Response,
  maxBytes = DEFAULT_EXTERNAL_JSON_LIMIT_BYTES,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    BigInt(declaredLength) > BigInt(maxBytes)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new ExternalResponseTooLargeError(maxBytes);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ExternalResponseTooLargeError(maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

export async function readBoundedJsonResponse<T = unknown>(
  response: Response,
  maxBytes = DEFAULT_EXTERNAL_JSON_LIMIT_BYTES,
): Promise<T> {
  const text = await readBoundedResponseText(response, maxBytes);
  return JSON.parse(text) as T;
}

export class ExternalResponseTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`External response exceeded the ${maxBytes}-byte limit`);
    this.name = "ExternalResponseTooLargeError";
  }
}
