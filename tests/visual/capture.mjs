// Drives one page into one state and returns PNG buffers.
// Both projects go through this identical code path, in the same browser, with the same
// viewport, device scale factor, zoom, locale, timezone and reduced-motion setting.
import { VIEWPORTS } from './cases.mjs';

const MAX_FULL_HEIGHT = 12000;
const SEGMENT = 900;

export const browserOptions = {
  args: ['--font-render-hinting=none', '--disable-font-subpixel-positioning', '--hide-scrollbars'],
  locale: 'en-US',
  timezoneId: 'UTC',
};

export async function openPage(browser, { width, height, deviceScaleFactor = 1 }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor, ...browserOptions });
  const page = await context.newPage();
  // The editor builds its 592-entry style catalogue from 117 reader pages on first use,
  // which is CPU-bound and can take the better part of a minute.
  page.setDefaultTimeout(240000);
  await page.addInitScript(() => {
    // Identical browser storage start for both projects.
    try { localStorage.clear(); } catch {}
  });
  return { context, page };
}

// Waits for fonts, two animation frames and a short settle. Expressed as waitForFunction
// rather than evaluate so that it is bounded by the page timeout instead of hanging if a
// frame never arrives.
export async function settle(page) {
  await page.waitForFunction(() => document.fonts.ready.then(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(true), 250)));
  })), null, { timeout: 120000 });
}

// Scrolls to an absolute y and waits for the geometry cache to be re-measured.
async function scrollTo(page, y) {
  await page.evaluate((value) => window.scrollTo(0, value), y);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 120))));
}

async function underlineCenter(page, index) {
  return page.evaluate((wanted) => {
    const nodes = [...document.querySelectorAll('[data-underline-id]')];
    const node = nodes[wanted];
    if (!node) return null;
    node.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, index);
}

// Reproduces the reader's own hit rule so the pointer genuinely lands on a painted line.
async function lineCenter(page, index) {
  return page.evaluate((wanted) => {
    const lines = [...document.querySelectorAll('[data-reader-line]')].filter((line) => {
      const style = getComputedStyle(line);
      return parseFloat(style.borderLeftWidth) || parseFloat(style.borderRightWidth);
    });
    const line = lines[wanted];
    if (!line) return null;
    line.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = line.getBoundingClientRect();
    const left = parseFloat(getComputedStyle(line).borderLeftWidth);
    const right = parseFloat(getComputedStyle(line).borderRightWidth);
    return { x: (left ? rect.left + left / 2 : rect.right - right / 2), y: rect.top + rect.height / 2, rect: { top: rect.top, bottom: rect.bottom } };
  }, index);
}

async function toggleReaderControl(page, labelText, checked) {
  const input = page.locator(`.reader-controls label:text-is("${labelText}")`).locator('input');
  if ((await input.isChecked()) !== checked) await input.click();
  await settle(page);
}

async function applyReaderState(page, state) {
  switch (state) {
    case 'idle':
    case 'print':
    case 'mobile':
      break;
    case 'hover-underline': {
      const point = await underlineCenter(page, 1);
      if (point) await page.mouse.move(point.x, point.y, { steps: 4 });
      await page.waitForTimeout(150);
      break;
    }
    case 'hover-line': {
      const point = await lineCenter(page, 0);
      if (point) await page.mouse.move(point.x, point.y, { steps: 4 });
      await page.waitForTimeout(150);
      break;
    }
    case 'collapsed': {
      const point = await lineCenter(page, 0);
      if (point) {
        await page.mouse.move(point.x, point.y, { steps: 4 });
        await page.mouse.dblclick(point.x, point.y);
      }
      await settle(page);
      break;
    }
    case 'expanded': {
      for (const index of [0]) {
        const point = await lineCenter(page, index);
        if (point) {
          await page.mouse.move(point.x, point.y, { steps: 4 });
          await page.mouse.dblclick(point.x, point.y);
        }
        await settle(page);
      }
      for (const index of [0]) {
        const point = await lineCenter(page, index);
        if (point) {
          await page.mouse.move(point.x, point.y, { steps: 4 });
          await page.mouse.dblclick(point.x, point.y);
        }
        await settle(page);
      }
      break;
    }
    case 'nested-collapse': {
      for (const index of [0, 1, 2]) {
        const point = await lineCenter(page, index);
        if (point) {
          await page.mouse.move(point.x, point.y, { steps: 4 });
          await page.mouse.dblclick(point.x, point.y);
        }
        await settle(page);
      }
      break;
    }
    case 'simple-layout':
      await toggleReaderControl(page, ' Structured layout', false);
      break;
    case 'underlines-hidden':
      await toggleReaderControl(page, ' Show underlines', false);
      break;
    case 'keyboard-focus': {
      await page.evaluate(() => {
        const line = [...document.querySelectorAll('[data-reader-line]')].find((item) => item.tabIndex >= 0) ?? document.querySelector('[data-reader-line]');
        line?.focus();
      });
      await settle(page);
      break;
    }
    default:
      throw new Error(`Unknown reader state: ${state}`);
  }
}

export async function captureReader(page, origin, testCase, state) {
  if (state === 'print') await page.emulateMedia({ media: 'print' });
  if (state === 'mobile') await page.setViewportSize(VIEWPORTS.mobile);
  const url = `${origin}/interactive_beta/${testCase.page.split('/').map(encodeURIComponent).join('/')}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('.reader-controls'), null, { timeout: 15000 }).catch(() => {
    throw new Error(`Reader controls were not injected at ${url}`);
  });
  await settle(page);
  await applyReaderState(page, state);
  const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
  const shots = [];
  if (!testCase.tall && height <= MAX_FULL_HEIGHT && !['mobile', 'print'].includes(state)) {
    shots.push({ suffix: 'full', buffer: await page.screenshot({ fullPage: true }) });
  } else {
    const viewport = page.viewportSize();
    const positions = [];
    for (let y = 0; y < height; y += SEGMENT) positions.push(y);
    if (!positions.length) positions.push(0);
    if (testCase.tall) positions.length = Math.min(positions.length, 14);
    for (const [index, y] of positions.entries()) {
      await scrollTo(page, y);
      shots.push({ suffix: `view${String(index).padStart(2, '0')}`, buffer: await page.screenshot() });
    }
  }
  return shots;
}

// --- editor states -------------------------------------------------------------------

export async function captureEditor(page, origin, testCase, state) {
  await page.goto(`${origin}/?workspace=interactive_beta`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === 'Saved');
  const guide = page.locator('#guide-dialog');
  if (await guide.evaluate((element) => element.open)) {
    await page.locator('#guide-dont-show').check();
    await page.locator('#guide-start').click();
  }
  await page.selectOption('#page-select', testCase.page);
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === 'Saved');
  const frame = page.frameLocator('#document');
  await frame.locator('body').waitFor();
  await settle(page);
  if (state === 'hover-underline') {
    const box = await frame.locator('[data-underline-id]').nth(1).boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await page.waitForTimeout(150);
  } else if (state === 'group-selected') {
    const group = frame.locator('[data-underline-id][data-underline-groups]').first();
    await group.click();
    // Capture only once the click has been fully processed: the selection readout and the
    // member list both update from it, and the click scrolls the annotation into view.
    await page.waitForFunction(() => document.querySelector('#selection-state')?.textContent !== 'No selection'
      && document.querySelectorAll('#member-list input').length > 0, null, { timeout: 20000 });
    await page.waitForTimeout(600);
  } else if (state === 'catalog') {
    await page.locator('#style-filter').fill('gradient');
    await page.waitForTimeout(200);
  } else if (state !== 'ready') {
    throw new Error(`Unknown editor state: ${state}`);
  }
  await settle(page);
  return [{ suffix: 'full', buffer: await page.screenshot() }];
}
