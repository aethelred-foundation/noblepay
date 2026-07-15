#!/usr/bin/env node
/**
 * Assemble a runnable Next.js standalone bundle.
 *
 * `output: "standalone"` emits a minimal server at .next/standalone/server.js
 * but DELIBERATELY excludes the client assets (.next/static) and the public/
 * folder. Serving the standalone server without them returns HTML whose
 * /_next/static/* chunks all 404: React never hydrates, and next/link clicks
 * fire preventDefault but router.push can't load the target page — so the nav
 * menu "does nothing" and the URL never changes. This copies the assets into
 * the standalone tree so `node .next/standalone/server.js` is fully working.
 *
 * Runs automatically after `next build` (postbuild); safe to re-run.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const standalone = join(root, '.next', 'standalone');

if (!existsSync(join(standalone, 'server.js'))) {
  console.log('[standalone] no standalone server (output != "standalone"); nothing to prepare.');
  process.exit(0);
}

// .next/static -> .next/standalone/.next/static (replace to avoid stale/nested copies)
const staticSrc = join(root, '.next', 'static');
const staticDst = join(standalone, '.next', 'static');
if (existsSync(staticSrc)) {
  rmSync(staticDst, { recursive: true, force: true });
  cpSync(staticSrc, staticDst, { recursive: true });
  console.log('[standalone] copied .next/static');
}

// public -> .next/standalone/public
const publicSrc = join(root, 'public');
const publicDst = join(standalone, 'public');
if (existsSync(publicSrc)) {
  rmSync(publicDst, { recursive: true, force: true });
  cpSync(publicSrc, publicDst, { recursive: true });
  console.log('[standalone] copied public/');
}

console.log('[standalone] ready — run: node .next/standalone/server.js');
