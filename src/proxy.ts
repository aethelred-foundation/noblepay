import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export function isRoadmapPreviewEnvironment(
  environment: string | undefined,
): boolean {
  return environment === "development" || environment === "test";
}

export function roadmapPageResponse(
  environment: string | undefined,
): NextResponse {
  if (isRoadmapPreviewEnvironment(environment)) {
    return NextResponse.next();
  }

  return new NextResponse(null, {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export function proxy(_request: NextRequest): NextResponse {
  return roadmapPageResponse(process.env.NODE_ENV);
}

// Keep this list literal so Next.js can statically extract every matcher.
export const config = {
  matcher: [
    "/treasury/:path*",
    "/liquidity/:path*",
    "/streaming/:path*",
    "/ai-compliance/:path*",
    "/invoice-financing/:path*",
    "/fx-hedging/:path*",
    "/cross-chain/:path*",
  ],
};
