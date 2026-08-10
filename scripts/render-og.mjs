/* Render og.svg to og.png at 1200x630.
 *
 * Goes through headless Chromium rather than an SVG rasteriser because the
 * card sets type in Fraunces and Geist Mono, and those are @font-face files in
 * fonts/ rather than installed system fonts. A rasteriser would silently fall
 * back to Georgia and a system mono.
 *
 * Not part of the deploy. The repo has no build step and no dependencies:
 * og.png is committed. Re-run this only when og.svg changes.
 *
 *   node scripts/render-og.mjs [path-to-playwright-package]
 *
 * Playwright is not a dependency of this repo. Pass the directory of a project
 * that has it, or set PLAYWRIGHT_FROM.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = process.argv[2] || process.env.PLAYWRIGHT_FROM;

if (!from) {
  console.error('Playwright is not a dependency here. Point at a project that has it:');
  console.error('  node scripts/render-og.mjs ../some-project-with-playwright/');
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = createRequire(path.resolve(from) + '/')('playwright'));
} catch (err) {
  console.error('Could not load playwright from ' + from + ': ' + err.message);
  process.exit(1);
}

const svg = fs.readFileSync(path.join(ROOT, 'og.svg'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'app.css'), 'utf8');

/* Reuse the @font-face rules from app.css so the card can never drift from the
   fonts the page itself serves. The relative url() is rewritten to a data URI
   because setContent renders at about:blank, where a relative path has no base
   to resolve against. */
const faces = css
  .slice(css.indexOf('@font-face'), css.indexOf(':root{'))
  .replace(/url\((fonts\/[^)]+)\)/g, (_, rel) => {
    const b64 = fs.readFileSync(path.join(ROOT, rel)).toString('base64');
    return `url(data:font/woff2;base64,${b64})`;
  });

const page = `<!doctype html><meta charset="utf-8">
<style>${faces}
html,body{margin:0;padding:0;background:#14110E}
svg{display:block}</style>
${svg}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();

await p.setContent(page, { waitUntil: 'load' });
await p.evaluate(() => document.fonts.ready);

const loaded = await p.evaluate(() => ({
  display: document.fonts.check('104px "Fraunces Variable"'),
  mono: document.fonts.check('19px "Geist Mono Variable"'),
}));
if (!loaded.display || !loaded.mono) {
  console.error('Fonts did not load, refusing to write a card in fallback type:', loaded);
  await browser.close();
  process.exit(1);
}

const out = path.join(ROOT, 'og.png');
await p.screenshot({ path: out, clip: { x: 0, y: 0, width: 1200, height: 630 } });
await browser.close();

const { size } = fs.statSync(out);
console.log('wrote og.png  1200x630  ' + (size / 1024).toFixed(0) + ' KB  fonts:', loaded);
