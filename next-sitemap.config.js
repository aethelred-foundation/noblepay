/** @type {import('next-sitemap').IConfig} */
module.exports = {
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3008",
  generateRobotsTxt: true,
  generateIndexSitemap: false,
  outDir: "./public",
  exclude: [
    "/api/*",
    "/dashboard/*",
    "/admin/*",
    "/settings/*",
    "/treasury",
    "/liquidity",
    "/streaming",
    "/ai-compliance",
    "/invoice-financing",
    "/fx-hedging",
    "/cross-chain",
    "/404",
    "/500",
  ],
  robotsTxtOptions: {
    policies: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/dashboard/", "/admin/", "/settings/"],
      },
    ],
  },
};
