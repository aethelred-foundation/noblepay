const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL || "").replace(
  /\/+$/,
  "",
);

export interface ApiPagination {
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
  [key: string]: unknown;
}

export interface ApiEnvelope<T, TPagination = ApiPagination> {
  success: boolean;
  data: T;
  pagination?: TPagination;
  message?: string;
}

interface ApiErrorPayload {
  error?: string;
  code?: string;
  message?: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly correlationId?: string;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      details?: unknown;
      correlationId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ApiError";
    this.status = options.status ?? 0;
    this.code = options.code ?? "API_REQUEST_FAILED";
    this.details = options.details;
    this.correlationId = options.correlationId;
  }
}

export interface ApiRequestOptions extends Omit<
  RequestInit,
  "body" | "credentials"
> {
  /** JSON request body. Content-Type is set automatically. */
  json?: unknown;
  /** Raw request body for non-JSON endpoints. */
  body?: BodyInit | null;
  /** Request timeout. Set to 0 to disable the default timeout. */
  timeoutMs?: number;
  /** Authentication/bootstrap endpoints may explicitly omit CSRF protection. */
  csrf?: "required" | "omit";
}

export interface ApiResponse<T, TPagination = ApiPagination> {
  data: T;
  pagination?: TPagination;
  message?: string;
  correlationId?: string;
}

function getCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;

  const encodedName = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie.split(";")) {
    const cookie = part.trim();
    if (cookie.startsWith(encodedName)) {
      return decodeURIComponent(cookie.slice(encodedName.length));
    }
  }
  return undefined;
}

function isStateChanging(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function resolveUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  return text || undefined;
}

function buildError(
  response: Response,
  parsed: unknown,
  correlationId?: string,
): ApiError {
  const payload =
    parsed && typeof parsed === "object" ? (parsed as ApiErrorPayload) : {};
  const fallback =
    typeof parsed === "string" && parsed.trim()
      ? parsed.trim()
      : `Request failed with status ${response.status}`;

  return new ApiError(payload.message || fallback, {
    status: response.status,
    code: payload.code || payload.error || `HTTP_${response.status}`,
    details: payload.details,
    correlationId,
  });
}

/**
 * Perform an authenticated NoblePay API request and return its envelope data.
 * Session cookies are included and mutating requests require the readable
 * `noblepay_csrf` cookie, which is copied into the X-CSRF-Token header.
 */
export async function apiRequestEnvelope<T, TPagination = ApiPagination>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<ApiResponse<T, TPagination>> {
  const method = (options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");

  let body = options.body;
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.json);
  }

  if (isStateChanging(method) && options.csrf !== "omit") {
    const csrfToken = getCookie("noblepay_csrf");
    if (!csrfToken) {
      throw new ApiError(
        "Your session is missing CSRF protection. Sign in again and retry.",
        { code: "CSRF_TOKEN_MISSING" },
      );
    }
    headers.set("X-CSRF-Token", csrfToken);
  }

  const controller = new AbortController();
  const timeoutMs =
    options.timeoutMs === undefined ? 15_000 : options.timeoutMs;
  const timeout =
    timeoutMs > 0
      ? setTimeout(
          () => controller.abort(new Error("Request timed out")),
          timeoutMs,
        )
      : undefined;
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    controller.abort(options.signal.reason);
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const response = await fetch(resolveUrl(path), {
      ...options,
      method,
      headers,
      body,
      credentials: "include",
      signal: controller.signal,
    });
    const parsed = await parseResponse(response);
    const correlationId = response.headers.get("x-correlation-id") || undefined;

    if (!response.ok) {
      throw buildError(response, parsed, correlationId);
    }

    if (parsed && typeof parsed === "object" && "success" in parsed) {
      const success = (parsed as { success?: unknown }).success;
      if (success === false) {
        const payload = parsed as ApiErrorPayload;
        throw new ApiError(payload.message || "The API rejected the request", {
          code: payload.code || payload.error || "API_REJECTED",
          details: payload.details,
          correlationId,
        });
      }
    }

    if (parsed && typeof parsed === "object" && "data" in parsed) {
      const envelope = parsed as ApiEnvelope<T, TPagination>;
      return {
        data: envelope.data,
        pagination: envelope.pagination,
        message: envelope.message,
        correlationId,
      };
    }

    // Some endpoints legitimately return 204 or a raw JSON value.
    return { data: parsed as T, correlationId };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) {
      throw new ApiError("The request was cancelled or timed out", {
        code: options.signal?.aborted ? "REQUEST_ABORTED" : "REQUEST_TIMEOUT",
        cause: error,
      });
    }
    throw new ApiError(
      error instanceof Error ? error.message : "Network request failed",
      { code: "NETWORK_ERROR", cause: error },
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export async function apiRequest<T>(
  path: string,
  options?: ApiRequestOptions,
): Promise<T> {
  return (await apiRequestEnvelope<T>(path, options)).data;
}

export function withQuery(
  path: string,
  values: Record<string, string | number | boolean | null | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
