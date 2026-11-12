import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ResourceManifest } from '../resources.js';
import { standaloneHtml, commitHtml } from '../html-output.js';
import { resolveConfig } from '../config.js';
import { runBuild } from '../build.js';
import { validateOutputPath } from '../output.js';

function fixture(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfpdf-html-test-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function dataBody(url: string): string {
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString('utf8');
}

test('HTML embeds local CSS, fonts, images and srcset while retaining links and scripts', (t) => {
  const dir = fixture(t);
  const manifest = new ResourceManifest();
  const image = path.join(dir, 'image.svg');
  fs.writeFileSync(image, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="12" height="12"/></svg>');
  const logical = manifest.add(image);
  const generated = new Map([
    ['generated/style.css', Buffer.from(`body { background: url('../${logical}'); }`)],
    ['generated/font.woff2', Buffer.from('font-bytes')],
    ['generated/fonts.css', Buffer.from('@font-face { font-family: demo; src: url("font.woff2"); unicode-range: U+0000-007F; } @font-face { font-family: unused; src: url("missing.woff2"); unicode-range: U+10FFFF; }')],
  ]);
  const input = `<!doctype html><html><head>
    <link rel="stylesheet" href="generated/fonts.css"><link rel="stylesheet" href="generated/style.css">
    <style>p { background: url('${logical}'); }</style></head><body>
    <img src="${logical}" srcset="${logical} 1x, ${logical} 2x">
    <div style="background: url('${logical}')"></div>
    <a href="#answer">Answer</a><a href="https://github.com/example/repo">Source</a>
    <details id="answer"><summary>Answer</summary>42</details><script>window.example = 1;</script>
    </body></html>`;
  const dom = new JSDOM(standaloneHtml(input, manifest, generated));
  const window = dom.window as { document: Document; close: () => void };
  t.after(() => { window.close(); });
  const doc = window.document;
  assert.match(doc.querySelector('img')!.src, /^data:image\/svg\+xml;base64,/);
  assert.match(doc.querySelector('img')!.srcset, /^data:image\/svg\+xml;base64,.* 1x, data:.* 2x$/);
  const styles = [...doc.querySelectorAll('link')].map((link) => dataBody(link.href));
  assert.match(styles[0]!, /url\("data:font\/woff2;base64,/);
  assert.doesNotMatch(styles[0]!, /missing|unused/);
  assert.match(styles[1]!, /url\("data:image\/svg\+xml;base64,/);
  assert.match(doc.querySelector('div')!.getAttribute('style') ?? '', /data:image\/svg/);
  assert.equal(doc.querySelector('a')!.getAttribute('href'), '#answer');
  assert.match(doc.querySelector('script')!.textContent, /window.example = 1/);
});

test('HTML export refuses missing resources and does not replace an existing output on commit failure', (t) => {
  const dir = fixture(t);
  const output = path.join(dir, 'report.html');
  fs.writeFileSync(output, 'previous');
  assert.throws(() => standaloneHtml('<img src="missing.png">', new ResourceManifest(), new Map()), /cannot embed/);
  assert.throws(() => commitHtml(output, 'new', () => { throw new Error('cleanup failed'); }), /cleanup failed/);
  assert.equal(fs.readFileSync(output, 'utf8'), 'previous');
  assert.deepEqual(fs.readdirSync(dir), ['report.html']);
  assert.equal(commitHtml(output, '<p>ready</p>', () => {}), 12);
  assert.equal(fs.readFileSync(output, 'utf8'), '<p>ready</p>');
});

test('HTML pipeline needs no browser, preserves quiz interaction and omits renderer callbacks', async (t) => {
  const dir = fixture(t);
  const input = path.join(dir, 'report.md');
  const output = path.join(dir, 'report.html');
  fs.writeFileSync(input, '# Report\n\n日本語の説明。\n\n<details><summary>正解を見る</summary>42</details>\n');
  const config = resolveConfig(['--input', input, '--output', output, '--template', 'compact', '--browser-path', path.join(dir, 'no-browser')], dir);
  const result = await runBuild(config, { SOURCE_DATE_EPOCH: '1750000000' }, { warn: () => {}, info: () => {}, debug: () => {} });
  assert.equal(result.byteSize, fs.statSync(output).size);
  const source = fs.readFileSync(output, 'utf8');
  assert.doesNotMatch(source, /__pfpdfReadiness|generated\/readiness/);
  const dom = new JSDOM(source);
  const window = dom.window as { document: Document; close: () => void };
  t.after(() => { window.close(); });
  const doc = window.document;
  assert.equal(doc.querySelector('summary')!.textContent, '正解を見る');
  assert.match(doc.body.textContent, /日本語の説明/);
  assert.ok([...doc.querySelectorAll('link')].every((link) => link.href.startsWith('data:')));
  validateOutputPath(path.join(dir, 'export.htm'), input);
  assert.throws(() => { validateOutputPath(path.join(dir, 'export.txt'), input); }, /extension/);
});
