// Opens every catalogued page in both projects and compares a rendered fingerprint:
// title, element counts, text, underline identifiers and memberships, section structure,
// geometry of annotated elements and their resolved styles. Also fails on any console
// error or failed request on either side.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer, stopAll, requireReference } from '../lib/servers.mjs';
import { browserOptions, settle } from '../visual/capture.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const referenceRoot = requireReference(process.env.YASIR_REFERENCE_ROOT ?? path.resolve(projectRoot, '../yasir_pro'));

// Inherited verbatim from the reference project: its Farsi page links ../../../Surah/fonts.css,
// which does not exist there either. Identical 404 on both sides; adding the file would change
// which stylesheets the page loads, so it is preserved rather than repaired.
const KNOWN_PROBLEMS = [{
  page: 'Surah/Farsi/061_Saff_farsi.html',
  problems: [
    'http 404: SITE/Surah/fonts.css',
    'request: SITE/Surah/fonts.css net::ERR_ABORTED',
    'console: Failed to load resource: the server responded with a status of 404 (Not Found)',
  ],
}];

const fingerprint = () => {
  const round = (value) => Math.round(value * 1000) / 1000;
  const elements = [...document.querySelectorAll('body *')];
  const geometry = elements.filter((element) => element.matches('[data-underline-id],[data-reader-line],[data-reader-section],[class*="connection-cap--"],sup,p')).map((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return [
      element.tagName, element.className || '', round(rect.left), round(rect.top), round(rect.width), round(rect.height),
      style.fontFamily, style.fontSize, style.lineHeight, style.color, style.borderBottomStyle, style.borderBottomWidth,
      style.borderBottomColor, style.borderRightWidth, style.paddingTop, style.paddingBottom,
      style.backgroundImage === 'none' ? 'none' : style.backgroundImage.slice(0, 80),
    ].join('|');
  });
  const underlines = [...document.querySelectorAll('[data-underline-id]')].map((element) => `${element.dataset.underlineId}=${element.dataset.underlineGroups ?? ''}`);
  const embedded = document.querySelector('#reader-group-data')?.textContent ?? '';
  return {
    title: document.title,
    direction: document.documentElement.dir,
    language: document.documentElement.lang,
    text: document.body.textContent.replace(/\s+/g, ' ').trim(),
    hashes: [...elements].map((element) => element.className).join(';'),
    geometry: geometry.join('\n'),
    underlines: underlines.join(','),
    embeddedGroups: JSON.parse(embedded || '{}'),
    sections: [...document.querySelectorAll('[data-reader-section]')].map((element) => `${element.dataset.readerSection}:${element.getAttribute('aria-label') ?? ''}`).join(','),
    lines: [...document.querySelectorAll('[data-reader-line]')].map((element) => element.dataset.readerLine).join(','),
    scrollHeight: round(document.documentElement.scrollHeight),
    controls: !!document.querySelector('.reader-controls'),
    fontCount: document.fonts.size,
    fontStatus: [...document.fonts].map((font) => `${font.family}:${font.status}`).sort().join(','),
    sheets: [...document.styleSheets].map((sheet) => {
      try { return `${new URL(sheet.href).pathname}:${sheet.cssRules.length}`; } catch { return `${sheet.href}:unreadable`; }
    }).join('\n'),
  };
};

let servers = [];
let browser;
let readerV1;
let readerV2;
let pages;

test.before(async () => {
  const reader = startServer({ label: 'reference-reader', file: 'interactive_beta/tools/serve.mjs', cwd: referenceRoot, port: 4413 });
  const project = startServer({ label: 'project-reader', file: 'scripts/serve-reader.mjs', cwd: projectRoot, port: 4423 });
  servers = [reader, project];
  readerV1 = (await reader.ready).origin;
  readerV2 = (await project.ready).origin;
  const catalog = JSON.parse(await readFile(path.join(projectRoot, 'app/interactive_beta/data/catalog.json'), 'utf8'));
  const referenceCatalog = JSON.parse(await readFile(path.join(referenceRoot, 'interactive_beta/data/catalog.json'), 'utf8'));
  assert.deepEqual(catalog, referenceCatalog, 'the reader data catalogue differs from the reference project');
  pages = catalog.pages;
  browser = await chromium.launch();
});

test.after(async () => {
  if (browser) await browser.close();
  await stopAll(servers);
});

async function inspect(origin, page) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...browserOptions });
  const tab = await context.newPage();
  tab.setDefaultTimeout(120000);
  const problems = [];
  // Origins differ by port, so URLs inside problem text are canonicalised before comparison.
  const canonical = (value) => value.replace(/https?:\/\/127\.0\.0\.1:\d+/g, 'SITE');
  tab.on('pageerror', (error) => problems.push(`console: ${canonical(error.message)}`));
  tab.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${canonical(message.text())}`); });
  tab.on('requestfailed', (request) => problems.push(`request: ${canonical(request.url())} ${request.failure()?.errorText}`));
  tab.on('response', (response) => { if (response.status() >= 400) problems.push(`http ${response.status()}: ${canonical(response.url())}`); });
  const url = `${origin}/interactive_beta/${page.split('/').map(encodeURIComponent).join('/')}`;
  await tab.goto(url, { waitUntil: 'load' });
  await settle(tab);
  const result = await tab.evaluate(fingerprint);
  await context.close();
  return { ...result, problems };
}

test('every catalogued page renders identically, with no unexpected console errors or missing assets', async () => {
  const report = [];
  for (const entry of pages) {
    const [before, after] = await Promise.all([inspect(readerV1, entry.page), inspect(readerV2, entry.page)]);
    const differences = [];
    for (const key of Object.keys(before)) {
      if (key === 'problems') continue;
      const expected = JSON.stringify(before[key]);
      const actual = JSON.stringify(after[key]);
      if (expected !== actual) differences.push(key);
    }
    // Requests that fail on one side must fail identically on the other, so the two
    // problem lists are compared rather than required to be empty.
    if (before.problems.join('|') !== after.problems.join('|')) {
      differences.push(`network/console: reference [${before.problems.join(', ')}] vs project [${after.problems.join(', ')}]`);
    }
    for (const problem of after.problems) {
      if (!KNOWN_PROBLEMS.some((known) => known.page === entry.page && known.problems.includes(problem))) {
        differences.push(`unexpected project problem: ${problem}`);
      }
    }
    if (differences.length) report.push(`${entry.page}: ${differences.join(', ')}`);
  }
  assert.deepEqual(report, [], `${report.length} pages differ:\n${report.join('\n')}`);
});
