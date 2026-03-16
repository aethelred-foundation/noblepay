/** @type {import('next-sitemap').IConfig} */
module.exports = {
  siteUrl: process.env.SITE_URL || 'https://noblepay.aethelred.network',
  generateRobotsTxt: true,
  generateIndexSitemap: false,
  outDir: './public',
  exclude: [
    '/api/*',
    '/dashboard/*',
    '/admin/*',
    '/settings/*',
    '/404',
    '/500',
  ],
  robotsTxtOptions: {
    policies: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/dashboard/', '/admin/', '/settings/'],
      },
    ],
  },
};
