// Compares the editor surface: the style catalogue it builds from reader data, the
// document it serves for every page, its routing and security guards, and the files it
// writes on save. Saves run against disposable copies so live documents are untouched.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createEditorServer } from '../../app/interactive_edit/server.mjs';
import { requireReference } from '../lib/servers.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const referenceRoot = requireReference(process.env.YASIR_REFERENCE_ROOT ?? path.resolve(projectRoot, '../yasir_pro'));
const referenceServer = await import(pathToFileURL(path.join(referenceRoot, 'inetractive_edit/server.mjs')).href);

const request = async (origin, route) => {
  const response = await fetch(`${origin}${route}`);
  return { status: response.status, type: response.headers.get('content-type'), body: await response.text() };
};

async function listen(createServer, options) {
  const { server } = await createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, server };
}

let reference;
let project;
let sandbox;
let fixtureA;
let fixtureB;
let existingRuns;

test.before(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'yasir-editor-parity-'));
  // A disposable site: v2's shared layer, with each project's reader mounted beside it
  // so the pages' ../../ stylesheet paths resolve exactly as they do in place.
  const shared = path.join(sandbox, 'site');
  await mkdir(shared, { recursive: true });
  for (const entry of ['fonts.css', 'styles', 'Surah', 'fonts']) {
    await cp(path.join(projectRoot, 'app', entry), path.join(shared, entry), { recursive: true });
  }
  fixtureA = path.join(shared, 'reader-reference');
  fixtureB = path.join(shared, 'reader-project');
  await cp(path.join(referenceRoot, 'interactive_beta'), fixtureA, { recursive: true });
  await cp(path.join(projectRoot, 'app/interactive_beta'), fixtureB, { recursive: true });
  existingRuns = new Set([...(await readdir(path.join(fixtureA, 'data/editor-history')).catch(() => [])), ...(await readdir(path.join(fixtureB, 'data/editor-history')).catch(() => []))]);
  reference = await listen(referenceServer.createEditorServer, { siteRoot: shared, defaultWorkspace: 'interactive_beta', workspaces: { interactive_beta: { dataRoot: fixtureA } } });
  project = await listen(createEditorServer, { siteRoot: shared, defaultWorkspace: 'interactive_beta', workspaces: { interactive_beta: { dataRoot: fixtureB } } });
});

test.after(async () => {
  reference?.server.close();
  project?.server.close();
  await rm(sandbox, { recursive: true, force: true });
});

const redact = (text) => text.replace(/"token":"[0-9a-f]+"/g, '"token":"<redacted>"');

test('the built style catalogue is identical', async () => {
  const [before, after] = await Promise.all([request(reference.origin, '/api/catalog'), request(project.origin, '/api/catalog')]);
  assert.equal(after.status, 200);
  const a = JSON.parse(redact(before.body));
  const b = JSON.parse(redact(after.body));
  assert.deepEqual(b.workspaces, [{ id: 'interactive_beta', label: 'interactive_beta' }], 'v2 exposes exactly the interactive_beta workspace');
  assert.equal(b.workspace, 'interactive_beta');
  delete a.workspaces; delete a.workspace; delete b.workspaces; delete b.workspace;
  assert.deepEqual(b, a, 'catalogue pages or generated styles differ');
  assert.equal(b.pages.length, 117);
  assert.ok(b.styles.length > 500, `expected the full generated style catalogue, saw ${b.styles.length}`);
});

test('every page is served and previewed byte-identically', async () => {
  const catalog = JSON.parse((await request(project.origin, '/api/catalog')).body);
  const differences = [];
  for (const entry of catalog.pages) {
    const query = `?workspace=interactive_beta&page=${encodeURIComponent(entry.page)}`;
    const [first, second] = await Promise.all([request(reference.origin, `/api/document${query}`), request(project.origin, `/api/document${query}`)]);
    const a = JSON.parse(first.body);
    const b = JSON.parse(second.body);
    for (const key of ['html', 'css', 'hash', 'cssHash']) {
      if (a[key] !== b[key]) differences.push(`${entry.page}: ${key}`);
    }
    const [preview1, preview2] = await Promise.all([request(reference.origin, `/document${query}`), request(project.origin, `/document${query}`)]);
    // The preview rewrites the <base> element to the workspace prefix, which differs by design.
    const normalise = (text) => text.replace(/<base href="\/(?:interactive|interactive_beta)\//, '<base href="/');
    if (preview1.status !== 200 || preview2.status !== 200) differences.push(`${entry.page}: preview status`);
    if (normalise(preview1.body) !== normalise(preview2.body)) differences.push(`${entry.page}: preview html`);
    if (/<script[\s>]/i.test(preview2.body.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ''))) {
      differences.push(`${entry.page}: preview kept a live script`);
    }
  }
  assert.deepEqual(differences, [], `${differences.length} document differences:\n${differences.join('\n')}`);
});

test('routing, host guard and workspace validation behave the same', async () => {
  const routes = ['/', '/app.js', '/app.css', '/vendor/lucide.js', '/fonts.css', '/styles/inline.css',
    '/styles/underlines.css', '/Surah/Style_CSS/002_CSS.css', '/fonts/Symbol.ttf',
    '/interactive_beta/index.html', '/interactive_beta/assets/interactions.js',
    '/book/Surah/001_Fatiha_html.html', '/nope.css', '/api/catalog?workspace=does_not_exist',
    '/api/document?page=../server.mjs', '/api/document?page=Surah/001_Fatiha_html.html'];
  for (const route of routes) {
    const [before, after] = await Promise.all([request(reference.origin, route), request(project.origin, route)]);
    assert.equal(after.status, before.status, `${route} status differs`);
    assert.equal(after.type, before.type, `${route} content type differs`);
  }
  // A Host header outside loopback must be refused identically by both projects.
  const foreign = async (origin) => {
    try {
      const response = await fetch(`${origin}/app.js`, { headers: { Host: 'evil.example' } });
      return `${response.status} ${(await response.text()).slice(0, 60)}`;
    } catch (error) {
      return `rejected ${error.message}`;
    }
  };
  const [referenceHost, projectHost] = await Promise.all([foreign(reference.origin), foreign(project.origin)]);
  assert.equal(projectHost, referenceHost, 'the loopback Host guard changed');
});

test('saving the same edit writes the same files in both projects', async () => {
  const page = 'Surah/001_Fatiha_html.html';
  const payload = async (origin) => {
    const catalog = JSON.parse((await request(origin, '/api/catalog')).body);
    const document = JSON.parse((await request(origin, `/api/document?page=${encodeURIComponent(page)}`)).body);
    const body = document.html.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1];
    const annotated = body.replace('data-underline-id="p001-u0001"', 'data-underline-id="p001-u0001" data-underline-groups="parity-probe"');
    assert.notEqual(annotated, body, 'probe target not found in the document body');
    return { token: catalog.token, save: { page, hash: document.hash, cssHash: document.cssHash, body: annotated, css: document.css, groupLabels: { 'parity-probe': 'Parity probe group' } } };
  };
  const save = async (origin, job) => {
    const response = await fetch(`${origin}/api/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Editor-Token': job.token }, body: JSON.stringify(job.save) });
    return { status: response.status, body: await response.text() };
  };
  const [jobA, jobB] = await Promise.all([payload(reference.origin), payload(project.origin)]);
  const [resultA, resultB] = await Promise.all([save(reference.origin, jobA), save(project.origin, jobB)]);
  assert.equal(resultA.status, 200, `reference save failed: ${resultA.body}`);
  assert.equal(resultB.status, 200, `project save failed: ${resultB.body}`);
  const touched = ['Surah/001_Fatiha_html.html', 'data/pages/Surah/001_Fatiha_html.json', 'data/editor-edits.json',
    'data/catalog.json', 'styles/editor-pages/Surah/001_Fatiha_html.css'];
  const read = async (root, file) => {
    try { return await readFile(path.join(root, file), 'utf8'); } catch (error) { return error.code === 'ENOENT' ? null : `error ${error.code}`; }
  };
  const normalise = (text) => text?.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<timestamp>') ?? null;
  const differences = [];
  for (const file of touched) {
    const [a, b] = await Promise.all([read(fixtureA, file), read(fixtureB, file)]);
    if (a === b) continue;
    if (typeof a === 'string' && typeof b === 'string' && normalise(a) === normalise(b)) continue;
    differences.push(`${file}: ${a === null || b === null ? `present only in ${a === null ? 'reference' : 'project'}` : 'content differs'}`);
  }
  assert.deepEqual(differences, [], `saved output differs:\n${differences.join('\n')}`);
  const savedHtml = await read(fixtureB, 'Surah/001_Fatiha_html.html');
  assert.match(savedHtml, /data-underline-groups="parity-probe"/, 'the save did not persist the membership');
  assert.match(savedHtml, /parity-probe/, 'the embedded reader group index was not updated');
  // Each save adds exactly one backup run holding the files it overwrote, at the same paths.
  const newRuns = async (root) => {
    const names = (await readdir(path.join(root, 'data/editor-history'))).filter((name) => !existingRuns.has(name));
    assert.equal(names.length, 1, `expected one new backup run in ${root}, saw ${names.length}`);
    return (await readdir(path.join(root, 'data/editor-history', names[0]), { recursive: true, encoding: 'utf8' })).sort();
  };
  const [runsA, runsB] = await Promise.all([newRuns(fixtureA), newRuns(fixtureB)]);
  assert.deepEqual(runsB, runsA, 'backup file layout differs');
});

test('save rejects a stale document hash the same way in both projects', async () => {
  const stale = async (origin) => {
    const catalog = JSON.parse((await request(origin, '/api/catalog')).body);
    const response = await fetch(`${origin}/api/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Editor-Token': catalog.token }, body: JSON.stringify({ page: 'Surah/001_Fatiha_html.html', hash: '0'.repeat(64), cssHash: '0'.repeat(64), body: '<p>x</p>', css: '' }) });
    return { status: response.status, error: (await response.json()).error };
  };
  const [before, after] = await Promise.all([stale(reference.origin), stale(project.origin)]);
  assert.equal(after.status, before.status);
  assert.equal(after.error, before.error);
  const unauthorized = await fetch(`${project.origin}/api/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Editor-Token': 'wrong' }, body: '{}' });
  assert.equal(unauthorized.status, 403);
  const catalog = JSON.parse((await request(project.origin, '/api/catalog')).body);
  assert.ok(/^[0-9a-f]{48}$/.test(catalog.token), 'the session token format changed');
});
