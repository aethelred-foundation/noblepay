/** Public origin embedded into canonical links and wallet metadata. */
export function resolvePublicSiteUrl(
  value = process.env.NEXT_PUBLIC_SITE_URL,
  nodeEnv = process.env.NODE_ENV,
): string {
  const raw = value?.trim();
  if (!raw) {
    if (nodeEnv === "production") {
      throw new Error("NEXT_PUBLIC_SITE_URL is required for production builds");
    }
    return "http://localhost:3008";
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("NEXT_PUBLIC_SITE_URL must be a valid absolute URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("NEXT_PUBLIC_SITE_URL must use http or https");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL must be an origin without credentials, path, query, or fragment",
    );
  }
  if (nodeEnv === "production" && parsed.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_SITE_URL must use https in production");
  }
  return parsed.origin;
}

const IS_UNCONFIGURED_VERCEL_PREVIEW =
  process.env.NEXT_PUBLIC_NOBLEPAY_CONFIGURATION_STATE ===
  "unconfigured-preview";

export const PUBLIC_SITE_URL = resolvePublicSiteUrl(
  IS_UNCONFIGURED_VERCEL_PREVIEW
    ? "https://noblepay.vercel.app"
    : process.env.NEXT_PUBLIC_SITE_URL,
  IS_UNCONFIGURED_VERCEL_PREVIEW ? "development" : process.env.NODE_ENV,
);
