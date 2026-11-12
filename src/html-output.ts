/** Portable HTML: embed local assets without starting a browser or asset server. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fromHtml } from 'hast-util-from-html';
import { toHtml } from 'hast-util-to-html';
import { visit } from 'unist-util-visit';
import type { Root } from 'hast';
import { MIME } from './assetserver.js';
import { InputError, RuntimeError } from './errors.js';
import { FETCH_ATTRIBUTES, isFetchAttribute, mapCssUrls, rewriteSrcset, type ResourceManifest } from './resources.js';

export function standaloneHtml(html: string, manifest: ResourceManifest, generated: Map<string, Buffer>): string {
  const root = fromHtml(html) as unknown as Root;
  const characters = new Set<number>();
  // Keep ASCII needed by counters and generated labels, plus document/CSS text.
  for (let code = 0; code < 128; code++) characters.add(code);
  const collect = (text: string): void => { for (const char of text) characters.add(char.codePointAt(0)!); };
  visit(root, 'text', (node) => { collect(node.value); });
  for (const [name, bytes] of generated) {
    if (name.endsWith('.css') && name !== 'generated/fonts.css') collect(bytes.toString('utf8'));
  }
  const origin = 'https://pfpdf.invalid/';
  const cache = new Map<string, string>();
  const pending = new Set<string>();
  const embed = (value: string, base = origin): string => {
    if (value === '' || value.startsWith('#') || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(value)) return value;
    const url = new URL(value, base);
    const logical = url.pathname.slice(1);
    const key = url.origin + url.pathname;
    const cached = cache.get(key);
    if (cached) return cached + url.hash;
    if (pending.has(key)) throw new InputError(`circular HTML asset reference: ${logical}`);
    pending.add(key);
    try {
      const file = manifest.get(logical);
      let bytes = generated.get(logical) ?? (file ? fs.readFileSync(file) : undefined);
      if (!bytes) throw new InputError(`cannot embed HTML asset: ${logical}`);
      const ext = path.extname(logical).toLowerCase();
      if (ext === '.css') {
        const css = logical === 'generated/fonts.css'
          ? usedFontFaces(bytes.toString('utf8'), characters)
          : bytes.toString('utf8');
        bytes = Buffer.from(mapCssUrls(css, (v) => embed(v, key)));
      }
      const mime = MIME[ext] ?? 'application/octet-stream';
      const result = `data:${mime};base64,${bytes.toString('base64')}`;
      cache.set(key, result);
      return result + url.hash;
    } finally {
      pending.delete(key);
    }
  };
  visit(root, 'element', (element) => {
    const props = element.properties ??= {};
    for (const attribute of FETCH_ATTRIBUTES[element.tagName] ?? []) {
      const value = props[attribute];
      if (typeof value === 'string' && isFetchAttribute(element, attribute)) {
        props[attribute] = embed(value);
      }
    }
    if (typeof props.srcSet === 'string') {
      props.srcSet = rewriteSrcset(props.srcSet, '', manifest, 'HTML srcset', embed);
    }
    if (typeof props.style === 'string') props.style = mapCssUrls(props.style, embed);
    if (element.tagName === 'style') {
      for (const child of element.children) {
        if (child.type === 'text') child.value = mapCssUrls(child.value, embed);
      }
    }
    if (element.tagName === 'head') {
      element.children.push({ type: 'element', tagName: 'style', properties: {}, children: [{ type: 'text', value:
        '@media screen { body { max-width: 960px; margin: 0 auto; padding: 24px; } img { max-width: 100%; height: auto; } }',
      }] });
    }
  });
  return toHtml(root as never, { allowDangerousHtml: true });
}

/** Fontsource emits independent @font-face rules for Unicode subsets. */
function usedFontFaces(css: string, characters: Set<number>): string {
  return css.replace(/@font-face\s*\{[^}]*\}/gi, (face) => {
    const ranges = /unicode-range\s*:\s*([^;}]+)/i.exec(face)?.[1];
    if (!ranges) return face;
    for (const range of ranges.split(',')) {
      const parsed = /^\s*U\+([0-9a-f?]+)(?:-([0-9a-f]+))?\s*$/i.exec(range);
      if (!parsed) return face;
      const low = Number.parseInt(parsed[1]!.replace(/\?/g, '0'), 16);
      const high = Number.parseInt(parsed[2] ?? parsed[1]!.replace(/\?/g, 'f'), 16);
      for (const char of characters) if (char >= low && char <= high) return face;
    }
    return '';
  });
}

/** Keep existing output intact until every resource has been embedded successfully. */
export function commitHtml(output: string, html: string, beforeCommit: () => void): number {
  const tmp = path.join(path.dirname(output), `.pfpdf-${crypto.randomBytes(8).toString('hex')}.tmp`);
  let mode: number | undefined;
  try {
    const stat = fs.lstatSync(output);
    if (stat.isFile()) mode = stat.mode & 0o7777;
  } catch { /* New output uses the process umask. */ }
  try {
    fs.writeFileSync(tmp, html, { flag: 'wx', mode: 0o600 });
    const fd = fs.openSync(tmp, 'r+');
    try {
      // oxlint-disable-next-line typescript/no-deprecated -- Read the existing process umask, as in PDF output.
      fs.chmodSync(tmp, mode ?? (0o666 & ~process.umask()));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    beforeCommit();
    fs.renameSync(tmp, output);
    return Buffer.byteLength(html);
  } catch (error) {
    throw new RuntimeError(`cannot commit HTML output: ${(error as Error).message}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
