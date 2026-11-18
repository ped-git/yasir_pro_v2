// Proves yasir_pro_v2 stands alone: no path leaves the project, every local reference
// resolves, and both applications boot from a copy that has no sibling yasir_pro.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { startServer, stopAll } from '../lib/servers.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

// Inherited verbatim from the reference project, where Surah/fonts.css is absent too, so
// both projects emit the same 404 for it. Fixing it here would change rendering.
const KNOWN_GAPS = [{ page: 'Surah/Farsi/061_Saff_farsi.html', reference: 'Surah/fonts.css' }];

function isLocal(reference) {
  return !/^(?:https?:|data:|mailto:|javascript:|about:|blob:|#|tel:)/i.test(reference) && !/^[a-z]+:\/\/\//i.test(reference);
}

async function sourceFiles(root) {
  const found = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', '.output', '.git'].includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(?:html|css|js|mjs|json|command|md|py|txt)$/.test(entry.name)) found.push(full);
    }
  };
  await walk(root);
  return found;
}

test('no shipped file references yasir_pro or an absolute machine path', async () => {
  const shipped = (await sourceFiles(path.join(projectRoot, 'app'))).concat(await sourceFiles(path.join(projectRoot, 'scripts')));
  assert.ok(shipped.length > 400, `expected the whole application tree, saw ${shipped.length} files`);
  const offenders = [];
  for (const file of shipped) {
    const text = await readFile(file, 'utf8');
    if (/yasir_pro(?!_v2)/.test(text)) offenders.push(`${path.relative(projectRoot, file)}: contains a yasir_pro reference`);
    if (/\/Users\/|\/home\/|C:\\\\/.test(text)) offenders.push(`${path.relative(projectRoot, file)}: contains an absolute machine path`);
  }
  assert.deepEqual(offenders, [], 'application files must not mention the reference project');
});

test('every local reference inside the shipped tree resolves locally', async () => {
  const root = path.join(projectRoot, 'app');
  const files = await sourceFiles(root);
  const broken = [];
  const patterns = [/(?:href|src)\s*=\s*["']([^"']+)["']/gi, /url\(\s*["']?([^"')]+)["']?\s*\)/gi, /@import\s+["']([^"']+)["']/gi];
  for (const file of files) {
    if (!/\.(?:html|css|js|mjs)$/.test(file) || file.includes(`${path.sep}tests${path.sep}`)) continue;
    const text = await readFile(file, 'utf8');
    const references = new Set();
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) references.add(match[1]);
    }
    for (const reference of references) {
      if (!isLocal(reference) || reference.startsWith('/')) continue;
      const clean = reference.split('#')[0].split('?')[0];
      if (!clean) continue;
      const resolved = path.resolve(path.dirname(file), clean);
      if (!resolved.startsWith(root + path.sep)) { broken.push(`${path.relative(root, file)} -> ${reference} escapes app/`); continue; }
      if (KNOWN_GAPS.some((gap) => file.endsWith(gap.page) && clean.endsWith(gap.reference))) continue;
      if (/\.(?:html|css|js|json|ttf|woff2?)$/.test(clean) && !(await readFile(resolved).then(() => true, () => false))) {
        broken.push(`${path.relative(root, file)} -> ${reference} is missing`);
      }
    }
  }
  assert.deepEqual(broken, [], 'unresolved local references');
});

test('the reader references never climb above the application root', async () => {
  const pages = await readdir(path.join(projectRoot, 'app/interactive_beta/Surah'));
  let checked = 0;
  for (const name of pages.filter((item) => item.endsWith('.html'))) {
    const file = path.join(projectRoot, 'app/interactive_beta/Surah', name);
    const text = await readFile(file, 'utf8');
    for (const [, href] of text.matchAll(/href="([^"]+)"/g)) {
      if (!isLocal(href)) continue;
      const resolved = path.resolve(path.dirname(file), href.split('#')[0]);
      assert.ok(resolved.startsWith(path.join(projectRoot, 'app') + path.sep), `${name} -> ${href} resolves outside app/`);
      checked += 1;
    }
  }
  assert.ok(checked > 400, `expected to check the whole page set, saw ${checked}`);
});

test('the reader also runs from disk with no server at all', async () => {
  const root = path.join(projectRoot, 'app/interactive_beta');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const failures = [];
    const errors = [];
    page.on('requestfailed', (request) => failures.push(decodeURIComponent(request.url()).replace(root, 'READER')));
    page.on('pageerror', (error) => errors.push(error.message));
    for (const file of ['index.html', 'explanation.html', 'Surah/001_Fatiha_html.html', 'Surah/002_Baqarah_html.html', 'Surah/112_Ekhlas_html.html', 'Surah/Farsi/061_Saff_farsi.html']) {
      await page.goto(pathToFileURL(path.join(root, file)).href, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
    }
    // The Farsi page's missing ../Surah/fonts.css is inherited from the reference project.
    assert.deepEqual(failures.filter((url) => !url.endsWith('/Surah/fonts.css')), [], 'file:// asset requests failed');
    assert.deepEqual(errors, [], 'page errors while running from disk');
  } finally {
    await browser.close();
  }
});

test('both applications boot from an isolated copy with no sibling reference project', async () => {
  const sandbox = await mkdtemp(path.join(realpathSync(os.tmpdir()), 'yasir-v2-isolated-'));
  const servers = [];
  let browser;
  try {
    const isolated = path.join(sandbox, 'yasir_pro_v2');
    await mkdir(isolated, { recursive: true });
    for (const entry of ['app', 'scripts', 'package.json', 'package-lock.json']) {
      await cp(path.join(projectRoot, entry), path.join(isolated, entry), { recursive: true });
    }
    // Dependency directories are reinstallable, so they are linked rather than duplicated.
    await mkdir(path.join(isolated, 'node_modules'), { recursive: true });
    await cp(path.join(projectRoot, 'node_modules/playwright'), path.join(isolated, 'node_modules/playwright'), { recursive: true });
    await cp(path.join(projectRoot, 'node_modules/playwright-core'), path.join(isolated, 'node_modules/playwright-core'), { recursive: true });
    await cp(path.join(projectRoot, 'app/interactive_edit/node_modules'), path.join(isolated, 'app/interactive_edit/node_modules'), { recursive: true });

    // Nothing named yasir_pro exists next to the copy.
    assert.equal(await readdir(sandbox).then((items) => items.includes('yasir_pro')), false);

    const reader = startServer({ label: 'isolated-reader', file: 'scripts/serve-reader.mjs', cwd: isolated, port: 4513 });
    const editor = startServer({ label: 'isolated-editor', file: 'app/interactive_edit/server.mjs', cwd: isolated, port: 4523 });
    servers.push(reader, editor);
    const readerOrigin = (await reader.ready).origin;
    const editorOrigin = (await editor.ready).origin;

    browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(240000);
    const failures = [];
    const errors = [];
    page.on('requestfailed', (request) => failures.push(request.url()));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${readerOrigin}/interactive_beta/Surah/002_Baqarah_html.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.fonts.ready);
    assert.equal(await page.locator('[data-underline-id]').count(), 879);
    const catalog = await (await page.request.get(`${editorOrigin}/api/catalog`, { timeout: 240000 })).json();
    assert.equal(catalog.pages.length, 117);
    assert.deepEqual(catalog.workspaces.map((item) => item.id), ['interactive_beta']);
    assert.deepEqual(failures, []);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await stopAll(servers);
    await rm(sandbox, { recursive: true, force: true });
  }
});
