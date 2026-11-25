import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildStandaloneDemo } from './export-demo.mjs';

test('the double-click demo matches the site and includes its own data, styles and code', async () => {
  const html = await buildStandaloneDemo();
  const published = await readFile(new URL('../docs/demo.html', import.meta.url), 'utf8');
  assert.equal(published.replace(/\r\n/g, '\n'), html, 'Update docs/demo.html with node scripts/export-demo.mjs');
  assert.doesNotMatch(html, /<(?:script|link|img)\b[^>]+\b(?:src|href)=/iu);
  const data = html.match(/<script id="demo-data" type="application\/json">([\s\S]*?)<\/script>/u)[1];
  const { manifest, snapshot } = JSON.parse(data);
  assert.equal(manifest.source, 'demo');
  assert.equal(manifest.productCount, snapshot.products.length);
  assert.ok(snapshot.products.every(p => !p.itemUrl && !p.imageUrl));
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/u)[1];
  const style = html.match(/<style>([\s\S]*?)<\/style>/u)[1];
  assert.doesNotMatch(script, /^\s*import\s/mu);
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/u)[1];
  assert.match(policy, /connect-src 'none'/u);
  for (const text of [data, script, style]) {
    assert.ok(policy.includes("'sha256-" + createHash('sha256').update(text).digest('base64') + "'"));
  }
});
