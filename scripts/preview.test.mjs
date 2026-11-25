import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createPreviewServer } from './preview.mjs';

test('archive preview serves only the selected manifest and versioned snapshots', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'gpt-archive-preview-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const site = join(temp, 'site');
  const archive = join(temp, 'archive');
  await mkdir(join(site, 'data'), { recursive: true });
  await mkdir(join(archive, 'snapshots'), { recursive: true });
  const sha = 'b'.repeat(64);
  await Promise.all([
    writeFile(join(site, 'index.html'), 'viewer'),
    writeFile(join(site, 'data/manifest.json'), 'live'),
    writeFile(join(archive, 'manifest.json'), 'historic'),
    writeFile(join(archive, 'other.json'), 'unpublished'),
    writeFile(join(archive, 'snapshots', sha + '.json'), 'offers')
  ]);
  const server = createPreviewServer({ siteDir: site, dataDir: archive });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  assert.equal(await (await fetch(url)).text(), 'viewer');
  assert.equal(await (await fetch(url + '/data/manifest.json')).text(), 'historic');
  assert.equal(await (await fetch(url + '/data/snapshots/' + sha + '.json')).text(), 'offers');
  assert.equal((await fetch(url + '/data/other.json')).status, 404);
  await rm(join(archive, 'manifest.json'));
  assert.equal((await fetch(url + '/data/manifest.json')).status, 404);
});
