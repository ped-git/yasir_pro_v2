// Drives the reader and editor interactions that the reference project documents and
// compares the resulting DOM state, not just pixels: navigation, history, URL and
// browser-storage behaviour, real-pointer hover, keyboard toggling, collapse/expand
// restoration, and reload semantics.
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

let servers = [];
let browser;
let readerV1;
let readerV2;
let editorV1;
let editorV2;

test.before(async () => {
  const handles = [
    startServer({ label: 'reference-reader', file: 'interactive_beta/tools/serve.mjs', cwd: referenceRoot, port: 4433 }),
    startServer({ label: 'project-reader', file: 'scripts/serve-reader.mjs', cwd: projectRoot, port: 4443 }),
    startServer({ label: 'reference-editor', file: 'inetractive_edit/server.mjs', cwd: referenceRoot, port: 4453 }),
    startServer({ label: 'project-editor', file: 'app/interactive_edit/server.mjs', cwd: projectRoot, port: 4463 }),
  ];
  servers = handles;
  [readerV1, readerV2, editorV1, editorV2] = await Promise.all(handles.map((handle) => handle.ready.then((info) => info.origin)));
  browser = await chromium.launch();
});

test.after(async () => {
  if (browser) await browser.close();
  await stopAll(servers);
});

async function readerTab(origin) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...browserOptions });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('requestfailed', (request) => problems.push(`request ${request.url()}`));
  return { context, page, problems };
}

// The reader's own hit rule, evaluated against the real topmost element at the point.
const linePoint = (index) => {
  const lines = [...document.querySelectorAll('[data-reader-line]')].filter((line) => {
    const style = getComputedStyle(line);
    return parseFloat(style.borderLeftWidth) || parseFloat(style.borderRightWidth);
  });
  const line = lines[index];
  if (!line) return null;
  line.scrollIntoView({ block: 'center', behavior: 'instant' });
  const rect = line.getBoundingClientRect();
  const left = parseFloat(getComputedStyle(line).borderLeftWidth);
  const right = parseFloat(getComputedStyle(line).borderRightWidth);
  const x = Math.round(left ? rect.left + left / 2 : rect.right - right / 2);
  const y = Math.round(rect.top + rect.height / 2);
  return { x, y, line: line.dataset.readerLine };
};

const collapseSnapshot = () => ({
  collapsed: [...document.querySelectorAll('[data-reader-collapsed]')].map((element) => element.dataset.readerSection).sort(),
  expanded: [...document.querySelectorAll('[data-reader-line]')].map((element) => `${element.dataset.readerLine}:${element.getAttribute('aria-expanded')}`).sort(),
  markers: document.querySelectorAll('.reader-omission, [data-reader-omission]').length,
  visibleText: document.body.innerText.replace(/\s+/g, ' ').trim().length,
});

test('pointer hover reaches the underlines and lines it is documented to reach', async () => {
  const outcomes = [];
  for (const origin of [readerV1, readerV2]) {
    const { context, page } = await readerTab(origin);
    try {
      await page.goto(`${origin}/interactive_beta/Surah/002_Baqarah_html.html`, { waitUntil: 'load' });
      await settle(page);
      const points = await page.evaluate(linePoint, 0);
      assert.ok(points, 'no painted vertical line found');
      await page.mouse.move(points.x, points.y, { steps: 4 });
      await page.waitForTimeout(200);
      const highlighted = await page.evaluate(() => ({
        related: [...document.querySelectorAll('.reader-line-related')].map((element) => element.dataset.readerLine).sort(),
        active: document.querySelectorAll('.reader-active-line').length,
      }));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      const cleared = await page.evaluate(() => document.querySelectorAll('.reader-line-related, .reader-related').length);
      const hoveredLine = points.line;
      const nested = await page.evaluate(() => {
        // A leaf underline: at its centre the topmost element must be the annotation itself.
        const node = [...document.querySelectorAll('[data-underline-id]')]
          .find((element) => !element.querySelector('[data-underline-id]') && element.getBoundingClientRect().width > 20);
        node.scrollIntoView({ block: 'center', behavior: 'instant' });
        const rect = node.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        const hit = document.elementFromPoint(x, y);
        return { innermost: hit?.closest('[data-underline-id]') === node, id: node.dataset.underlineId };
      });
      outcomes.push({ hoveredLine, highlighted, cleared, nested });
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(outcomes[1], outcomes[0], 'hover, emphasis or Escape behaviour differs');
  assert.ok(outcomes[0].highlighted.related.includes(outcomes[0].hoveredLine), 'the hovered vertical line was not emphasised');
  assert.equal(outcomes[0].cleared, 0, 'Escape did not clear the highlight');
  assert.equal(outcomes[0].nested.innermost, true, 'a leaf underline was not the element hit at its centre');
});

test('double-click collapse, nested retention, expansion restoration and reload match', async () => {
  const outcomes = [];
  for (const origin of [readerV1, readerV2]) {
    const { context, page } = await readerTab(origin);
    try {
      await page.goto(`${origin}/interactive_beta/Surah/002_Baqarah_html.html`, { waitUntil: 'load' });
      await settle(page);
      const pristine = await page.evaluate(() => document.body.innerHTML);
      const points = [];
      for (const index of [0, 1, 2, 3]) points.push(await page.evaluate(linePoint, index));
      const steps = [];
      for (const point of points) {
        if (!point) continue;
        await page.mouse.move(point.x, point.y, { steps: 3 });
        await page.mouse.dblclick(point.x, point.y);
        await settle(page);
        steps.push(await page.evaluate(collapseSnapshot));
      }
      // Expand the outermost line again; nested state must come back exactly.
      await page.mouse.move(points[0].x, points[0].y, { steps: 3 });
      await page.mouse.dblclick(points[0].x, points[0].y);
      await settle(page);
      const afterOuterExpand = await page.evaluate(collapseSnapshot);
      await page.mouse.move(points[1].x, points[1].y, { steps: 3 });
      await page.mouse.dblclick(points[1].x, points[1].y);
      await settle(page);
      await page.reload({ waitUntil: 'load' });
      await settle(page);
      const afterReload = await page.evaluate((expected) => ({
        collapsed: document.querySelectorAll('[data-reader-collapsed]').length,
        html: document.body.innerHTML === expected,
      }), pristine);
      outcomes.push({ steps, afterOuterExpand, afterReload });
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(outcomes[1], outcomes[0], 'collapse/expand/reload behaviour differs');
  assert.ok(outcomes[0].steps.some((step) => step.collapsed.length > 0), 'nothing collapsed');
  assert.ok(outcomes[0].steps.every((step, index) => index === 0 || step.collapsed.length >= outcomes[0].steps[index - 1].collapsed.length), 'nested collapse state was not additive');
  assert.equal(outcomes[0].afterReload.collapsed, 0, 'collapse state survived a reload');
  assert.equal(outcomes[0].afterReload.html, true, 'reload did not restore the original markup');
});

test('keyboard toggling and focus visibility work the same', async () => {
  const outcomes = [];
  for (const origin of [readerV1, readerV2]) {
    const { context, page } = await readerTab(origin);
    try {
      await page.goto(`${origin}/interactive_beta/Surah/002_Baqarah_html.html`, { waitUntil: 'load' });
      await settle(page);
      const target = await page.evaluate(() => {
        const line = [...document.querySelectorAll('[data-reader-line]')].find((element) => element.tabIndex >= 0);
        if (!line) return null;
        line.scrollIntoView({ block: 'center', behavior: 'instant' });
        line.focus();
        const rect = line.getBoundingClientRect();
        return { line: line.dataset.readerLine, outline: getComputedStyle(line).outlineStyle, tabIndex: line.tabIndex, key: line.getAttribute('role') };
      });
      await page.keyboard.press('Enter');
      await settle(page);
      const afterEnter = await page.evaluate(collapseSnapshot);
      await page.keyboard.press('Space');
      await settle(page);
      const afterSpace = await page.evaluate(collapseSnapshot);
      outcomes.push({ target, afterEnter, afterSpace });
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(outcomes[1], outcomes[0], 'keyboard behaviour differs');
  assert.ok(outcomes[0].target, 'lines are not focusable');
  assert.notEqual(outcomes[0].target.outline, 'none', 'focused lines have no visible outline');
  assert.ok(outcomes[0].afterEnter.collapsed.length > 0, 'Enter did not toggle the focused line');
  assert.notEqual(outcomes[0].afterSpace.collapsed, outcomes[0].afterEnter.collapsed, 'Space did not toggle the focused line back');
});

test('index navigation reaches the same documents and history returns', async () => {
  const outcomes = [];
  for (const origin of [readerV1, readerV2]) {
    const { context, page } = await readerTab(origin);
    try {
      await page.goto(`${origin}/interactive_beta/index.html`, { waitUntil: 'load' });
      await settle(page);
      const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((anchor) => anchor.getAttribute('href')));
      const link = page.locator('a[href="Surah/002_Baqarah_html.html"]').first();
      await link.click();
      await page.waitForLoadState('load');
      const landed = { url: decodeURIComponent(page.url()), title: await page.title() };
      await page.goBack({ waitUntil: 'load' });
      const back = { url: decodeURIComponent(page.url()), links: (await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((anchor) => anchor.getAttribute('href')))).length };
      outcomes.push({ hrefs, landed, back });
    } finally {
      await context.close();
    }
  }
  assert.equal(outcomes[1].landed.title, outcomes[0].landed.title);
  assert.equal(outcomes[1].back.links, outcomes[0].back.links);
  // The absolute path tail must match; the host and port necessarily differ.
  assert.equal(outcomes[1].landed.url.split('/interactive_beta/')[1], outcomes[0].landed.url.split('/interactive_beta/')[1]);
  assert.equal(outcomes[1].back.url.split('/interactive_beta/')[1], outcomes[0].back.url.split('/interactive_beta/')[1]);
  assert.deepEqual(outcomes[1].hrefs, outcomes[0].hrefs, 'the index link set differs');
  assert.equal(outcomes[1].hrefs.filter((href) => href.startsWith('Surah/')).length, 114, 'expected 114 surah links');
});

test('the editor keeps the same URL and storage behaviour for the beta workspace', async () => {
  const outcomes = [];
  for (const origin of [editorV1, editorV2]) {
    const context = await browser.newContext({ viewport: { width: 1720, height: 1082 }, deviceScaleFactor: 1, ...browserOptions });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    const problems = [];
    page.on('pageerror', (error) => problems.push(error.message));
    try {
      // Both editors are opened on the beta workspace; v1 still offers a second reader.
      await page.goto(`${origin}/?workspace=interactive_beta`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === 'Saved');
      await page.locator('#guide-dont-show').check();
      await page.locator('#guide-start').click();
      await page.selectOption('#page-select', 'Surah/059_Hashr_html.html');
      await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === 'Saved');
      const state = await page.evaluate(() => ({
        path: document.querySelector('#document-path').textContent,
        styleCount: document.querySelector('#style-count').textContent,
        url: new URL(location.href).search,
        storage: Object.keys(localStorage).sort(),
        workspaceValue: document.querySelector('#workspace-select').value,
        groupRows: document.querySelectorAll('#group-list input').length,
        styleRows: document.querySelectorAll('#style-list label').length,
      }));
      const frameUrl = await page.locator('#document').evaluate((element) => new URL(element.src).pathname);
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === 'Saved');
      const restored = await page.evaluate(() => ({ path: document.querySelector('#document-path').textContent, workspaceValue: document.querySelector('#workspace-select').value, guideOpen: document.querySelector('#guide-dialog').open }));
      outcomes.push({ state, frameUrl, restored, problems });
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(outcomes[1].problems, [], 'the v2 editor reported page errors');
  assert.deepEqual(outcomes[0].problems, [], 'the reference editor reported page errors');
  // v2 names its only workspace interactive_beta; the reference suite's second fixture
  // reader is renamed, so that identifier is folded back before comparing.
  const stripWorkspace = (value) => JSON.parse(JSON.stringify(value).replace(/interactive_beta_alt/g, 'interactive_beta'));
  assert.deepEqual(stripWorkspace(outcomes[1].state), outcomes[0].state, 'editor state differs');
  assert.equal(outcomes[1].frameUrl, outcomes[0].frameUrl.replace(/^\/interactive\//, '/interactive_beta/'), 'the canvas route differs');
  assert.deepEqual(outcomes[1].restored, outcomes[0].restored, 'reload does not restore the same state');
  assert.equal(outcomes[1].state.styleCount, outcomes[0].state.styleCount);
});

test('reader data files are byte-identical to the reference project', async () => {
  const catalog = JSON.parse(await readFile(path.join(projectRoot, 'app/interactive_beta/data/catalog.json'), 'utf8'));
  const differences = [];
  for (const entry of catalog.pages) {
    const htmlA = await readFile(path.join(referenceRoot, 'interactive_beta', entry.page));
    const htmlB = await readFile(path.join(projectRoot, 'app/interactive_beta', entry.page));
    if (!htmlA.equals(htmlB)) differences.push(`${entry.page}: html`);
    const dataA = await readFile(path.join(referenceRoot, 'interactive_beta', entry.data));
    const dataB = await readFile(path.join(projectRoot, 'app/interactive_beta', entry.data));
    if (!dataA.equals(dataB)) differences.push(`${entry.page}: annotation data`);
  }
  assert.deepEqual(differences, [], `${differences.length} documents differ from the reference project`);
});
