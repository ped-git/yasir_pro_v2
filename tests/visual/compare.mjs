#!/usr/bin/env node
// Pixel comparison between the reference project (yasir_pro) and this one (yasir_pro_v2).
//
//   node tests/visual/compare.mjs [--only=caseId/state] [--attempts=N] [--no-noise]
//
// Reference root defaults to the sibling ../yasir_pro, overridable with
// YASIR_REFERENCE_ROOT. That dependency belongs to the test only: the applications
// themselves never read outside this project.
//
// Method, and why it is shaped this way:
//
// * Zero tolerance. Screenshots are compared byte-first; any difference is decoded and
//   every pixel and channel is measured. No tolerance, blur, mask or resizing is applied.
// * One freshly launched Chromium per capture, so neither side inherits glyph or
//   rasterisation cache state produced by the other.
// * Cross-pair matching. Chromium picks nondeterministically between two rasterisations of
//   certain right-gutter marks: repeated cold runs of the *same* project produce more than
//   one distinct render for some segments, so a single render-to-render comparison can
//   report tens of differing pixels between two projects that render identically. Each
//   side may therefore contribute several captured renders and a segment passes only on a
//   byte-identical one. A genuine rendering difference has no shared render and fails
//   every attempt. `report.json` records the number of distinct renders seen per side
//   (`distinctReferenceRenders` / `distinctProjectRenders`), the attempt count, and a
//   `noiseFloor` block that re-measures the browser's own variation on every run instead
//   of folding it into a threshold.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer, stopAll, requireReference } from '../lib/servers.mjs';
import { comparePngs } from '../lib/png.mjs';
import { readerCases, editorCases, VIEWPORTS } from './cases.mjs';
import { openPage, captureReader, captureEditor } from './capture.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const referenceRoot = requireReference(process.env.YASIR_REFERENCE_ROOT ?? path.resolve(projectRoot, '../yasir_pro'));
const outputDir = path.join(projectRoot, 'tests/.output/visual');
const argv = process.argv.slice(2);
const only = argv.find((arg) => arg.startsWith('--only='))?.slice(7);
const attempts = Number(argv.find((arg) => arg.startsWith('--attempts='))?.split('=')[1] ?? 4);
const measureNoise = !argv.includes('--no-noise');

const servers = [];
const results = [];
let origins;
let noise = null;

async function start(label, file, cwd, port) {
  const handle = startServer({ label, file, cwd, port });
  servers.push(handle);
  const info = await handle.ready;
  console.log(`${label}: ${info.origin}`);
  return info.origin;
}

async function shoot(kind, origin, testCase, state) {
  const browser = await chromium.launch();
  try {
    const viewport = kind === 'editor' ? { width: 1720, height: 1082 } : VIEWPORTS.desktop;
    const { context, page } = await openPage(browser, { ...viewport, deviceScaleFactor: 1 });
    try {
      return await (kind === 'editor'
        ? captureEditor(page, origin, testCase, state)
        : captureReader(page, origin, testCase, state));
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

// Byte-identity is symmetric, so a pass means one whole-page render of the reference
// project equals one whole-page render of this project, segment by segment. Every
// captured render on each side is a candidate; the loop stops at the first full match.
function bestAcross(referenceCaptures, projectCaptures) {
  let best = null;
  for (const reference of referenceCaptures) {
    for (const project of projectCaptures) {
      const segments = reference.map((shot, index) => ({
        name: shot.suffix ?? `view${String(index).padStart(2, '0')}`,
        ...comparePngs(shot.buffer, project[index].buffer),
        buffers: [shot.buffer, project[index].buffer],
      }));
      const differing = segments.filter((segment) => !segment.identical);
      if (!best || differing.length < best.differing.length) best = { segments, differing };
      if (!differing.length) return best;
    }
  }
  return best;
}

const distinctRenders = (captures) => new Set(captures.map((shots) => shots.map((shot) => shot.buffer.toString('base64')).join('|'))).size;

async function runCase(kind, originA, originB, testCase, state) {
  const reference = [];
  const project = [];
  let segments = [];
  let attempt = 0;
  while (attempt < attempts) {
    attempt += 1;
    // Sequentially: the editor's first catalog build is CPU-bound, and running both sides
    // at once pushed it past the navigation timeout.
    const before = await shoot(kind, originA, testCase, state);
    const after = await shoot(kind, originB, testCase, state);
    reference.push(before);
    project.push(after);
    if (before.length !== after.length) {
      segments = [{ name: '-', identical: false, sizeMismatch: true, differingPixels: 0, totalPixels: 0, maxChannelDifference: 0, buffers: [null, null] }];
      break;
    }
    const matched = bestAcross(reference, project);
    segments = matched.segments;
    if (!matched.differing.length) break;
  }
  const differing = segments.filter((segment) => !segment.identical);
  for (const [index, segment] of segments.entries()) {
    const name = `${testCase.id}__${state}__${segment.name}`;
    if (!segment.identical && segment.buffers[0]) {
      await writeFile(path.join(outputDir, `${name}.reference.png`), segment.buffers[0]);
      await writeFile(path.join(outputDir, `${name}.project.png`), segment.buffers[1]);
      if (segment.diffPng) await writeFile(path.join(outputDir, `${name}.diff.png`), segment.diffPng);
    }
    results.push({
      kind, case: testCase.id, page: testCase.page, state, label: testCase.label, shot: segment.name,
      identical: segment.identical, attempts: attempt,
      differingPixels: segment.differingPixels, totalPixels: segment.totalPixels,
      differingPercentage: segment.identical ? 0 : Number((segment.differingPercentage ?? 0).toFixed(6)),
      maxChannelDifference: segment.maxChannelDifference,
      dimensions: segment.width ? `${segment.width}x${segment.height}` : '',
      sizeMismatch: Boolean(segment.sizeMismatch),
      pngBytes: segment.buffers.map((buffer) => buffer.length),
      distinctReferenceRenders: distinctRenders(reference),
      distinctProjectRenders: distinctRenders(project),
    });
  }
  console.log(`${kind} ${testCase.id}/${state}: ${differing.length
    ? `NO MATCHING RENDER (${differing.length}/${segments.length} shots, best ${differing.reduce((total, s) => total + s.differingPixels, 0)} px, max channel delta ${Math.max(...differing.map((s) => s.maxChannelDifference))})`
    : `IDENTICAL (${segments.length} shots, attempt ${attempt}, ${distinctRenders(reference)}/${distinctRenders(project)} distinct renders)`}`);
  return { segments, reference, project };
}

try {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  origins = {
    readerReference: await start('reference-reader', 'interactive_beta/tools/serve.mjs', referenceRoot, 4373),
    readerProject: await start('project-reader', 'scripts/serve-reader.mjs', projectRoot, 4383),
    editorReference: await start('reference-editor', 'inetractive_edit/server.mjs', referenceRoot, 4393),
    editorProject: await start('project-editor', 'app/interactive_edit/server.mjs', projectRoot, 4403),
  };

  for (const testCase of readerCases) {
    for (const state of testCase.states) {
      if (only && !`${testCase.id}/${state}`.includes(only)) continue;
      await runCase('reader', origins.readerReference, origins.readerProject, testCase, state);
    }
  }
  for (const testCase of editorCases) {
    for (const state of testCase.states) {
      if (only && !`${testCase.id}/${state}`.includes(only)) continue;
      await runCase('editor', origins.editorReference, origins.editorProject, testCase, state);
    }
  }

  // Noise floor: the reference project compared with itself, one attempt, no cross-pair
  // retries. This quantifies the browser variation the policy above sees through.
  if (measureNoise) {
    const probe = readerCases.find((testCase) => testCase.id === '003_aleimran');
    const runs = [];
    for (let index = 0; index < 3; index += 1) {
      const a = await shoot('reader', origins.readerReference, probe, 'idle');
      const b = await shoot('reader', origins.readerReference, probe, 'idle');
      const measured = a.map((shot, i) => comparePngs(shot.buffer, b[i].buffer));
      runs.push({
        differingShots: measured.filter((comparison) => !comparison.identical).length,
        shots: measured.length,
        differingPixels: measured.reduce((total, comparison) => total + comparison.differingPixels, 0),
        totalPixels: measured.reduce((total, comparison) => total + comparison.totalPixels, 0),
        maxChannelDifference: Math.max(0, ...measured.map((comparison) => comparison.maxChannelDifference)),
      });
    }
    noise = { case: `${probe.id}/idle`, method: 'yasir_pro compared with itself, cold browser per side, single pair, no retries', runs };
    console.log(`noise floor (${noise.case}): ${runs.map((run) => `${run.differingPixels}px in ${run.differingShots}/${run.shots} shots, max delta ${run.maxChannelDifference}`).join(' | ')}`);
  }
} finally {
  await stopAll(servers);
}

const report = {
  generatedAt: new Date().toISOString().slice(0, 19) + 'Z',
  referenceRoot,
  browser: 'chromium, Playwright headless, launched fresh per side and per attempt',
  policy: { tolerance: 'none', attempts, rule: 'each segment needs one reference render byte-identical to a project render' },
  totals: { shots: results.length, identical: results.filter((item) => item.identical).length, differing: results.filter((item) => item.identical === false).length },
  noiseFloor: noise,
  results,
};
await writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.totals.identical}/${report.totals.shots} screenshots byte-identical · ${report.totals.differing} with no matching render`);
console.log(`report: ${path.join(outputDir, 'report.json')}`);
if (report.totals.differing) process.exitCode = 1;
