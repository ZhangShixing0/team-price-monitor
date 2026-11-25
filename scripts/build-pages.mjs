import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Publish only the reviewed archive and the files needed to render it.
// The hourly collector has its own output directory and is never invoked here.
const root = new URL('../', import.meta.url);
const archive = new URL('public-archive/', root);
const output = new URL('out/pages/', root);
const manifestFile = await readFile(new URL('manifest.json', archive));
const manifest = JSON.parse(manifestFile);
if (manifest.schemaVersion !== 2 || manifest.source !== 'archive' ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    manifest.snapshot !== `snapshots/${manifest.sha256}.json` ||
    !Number.isFinite(Date.parse(manifest.checkedAt))) {
  throw new Error('公开归档的清单无效。');
}
const data = await readFile(new URL(manifest.snapshot, archive));
if (createHash('sha256').update(data).digest('hex') !== manifest.sha256) {
  throw new Error('公开归档文件与清单的内容校验值不一致。');
}
const snapshot = JSON.parse(data);
if (snapshot.schemaVersion !== 2 || snapshot.checkedAt !== manifest.checkedAt ||
    !Array.isArray(snapshot.products) || !snapshot.products.length ||
    snapshot.products.length !== manifest.productCount) {
  throw new Error('公开归档的商品数或核验时间不一致。');
}
await mkdir(new URL('data/snapshots/', output), { recursive: true });
for (const name of ['index.html', 'style.css', 'app.js', 'catalog-view.mjs']) {
  await copyFile(new URL('site/' + name, root), new URL(name, output));
}
await writeFile(new URL('data/' + manifest.snapshot, output), data);
await writeFile(new URL('data/manifest.json', output), manifestFile);
await writeFile(new URL('.nojekyll', output), '');
console.log(`${snapshot.products.length} 条公开报价 · ${manifest.checkedAt} · ${fileURLToPath(output)}`);
