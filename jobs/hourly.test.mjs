import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPreviewServer } from '../scripts/preview.mjs';
import { runHourly } from './hourly.mjs';
import { replayArchive } from './replay.mjs';

const scopes = ['a', 'b'].map(shopToken => ({ shopToken, shopName: shopToken, goodsType: 'card', categoryId: 1, categoryName: 'Team' }));
const config = { shops: scopes.map(s => ({ shop_token: s.shopToken })), scopes };
const when = round => new Date(Date.UTC(2020, 10, 24, round)).toISOString();
function product(scope, goodsKey, extra = {}) {
  return { ...scope, goodsKey, name: 'ChatGPT Business 单人席位 1个月 仅网页 美区 CNY 每席位总价 无额外费用',
    currency: 'CNY', priceSymbol: '¥', price: 70, stockCount: 1, minQuantity: 1, ...extra };
}
function sample(round, rows = [product(scopes[0], 'one'), product(scopes[1], 'two')]) {
  return { runId: String(round), startedAt: when(round), finishedAt: when(round), complete: true, scopedComplete: true,
    products: rows.map(p => ({ ...p, observedAt: when(round) })), queries: scopes.map(s => {
      const total = rows.filter(p => p.shopToken === s.shopToken).length;
      return { ...s, complete: true, pages: 1, total, uniqueCount: total, returnedRows: total };
    }), stats: { elapsedMs: 100, requestCount: 2, measuredRequests: 2, transferBytes: 1024, transferMeasurementComplete: true } };
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hourly-publication-test-'));
  const outputDir = join(dir, 'site', 'data'), stateDir = join(dir, 'state');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { outputDir, stateDir, siteDir: join(dir, 'site'),
    run: run => runHourly({ config, outputDir, stateDir, collect: async () => run }),
    async current() {
      const manifest = JSON.parse(await readFile(join(outputDir, 'manifest.json'), 'utf8'));
      return { manifest, ...JSON.parse(await readFile(join(outputDir, manifest.snapshot), 'utf8')) };
    }
  };
}

test('HTTP clients retain the exact published manifest and prices through a partial round, an empty failure, and falsely complete data', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(sample(1))).published, true);
  const server = createPreviewServer({ siteDir: f.siteDir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/data/';
  async function load() {
    const manifestResponse = await fetch(base + 'manifest.json');
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.text();
    const snapshotResponse = await fetch(base + JSON.parse(manifest).snapshot);
    assert.equal(snapshotResponse.status, 200);
    return [manifest, await snapshotResponse.text()];
  }
  const baseline = await load();
  const first = sample(2); first.products[0].price = 1; first.queries[1].complete = false;
  first.complete = false; first.scopedComplete = false;
  const failed = { ...sample(3, []), complete: false, queries: [], error: 'source unavailable' };
  const inconsistent = sample(4); inconsistent.products = [];
  const allScopesEmpty = sample(5, []);
  const replay = sample(0);
  const overlap = sample(6); overlap.startedAt = when(0);
  const staleRow = sample(7); staleRow.products[0].observedAt = when(1);
  for (const round of [first, failed, inconsistent, allScopesEmpty, replay, overlap, staleRow]) {
    const status = await f.run(round);
    assert.equal(status.published, false);
    assert.deepEqual(await load(), baseline);
  }
  const zeroStock = sample(8, scopes.map((s, i) => product(s, ['one', 'two'][i], { stockCount: 0 })));
  assert.equal((await f.run(zeroStock)).published, true);
  const current = await f.current();
  assert.equal(current.products.length, 2);
  assert.ok(current.products.every(p => p.stockCount === 0 && p.inStock === false));
});

test('unchanged prices reuse the immutable file and advance the successful verification time', async t => {
  const f = await fixture(t);
  const first = await f.run(sample(1)), second = await f.run(sample(2));
  assert.equal(first.published && second.published, true);
  assert.equal(second.fileChanged, false);
  assert.equal(second.snapshot, first.snapshot);
  assert.equal((await f.current()).manifest.checkedAt, when(2));
});

test('the first three-plan publication upgrades a Team-only directory without announcing old catalog entries as new', async t => {
  const f = await fixture(t);
  await f.run(sample(1, [product(scopes[0], 'existing')]));
  const current = await f.current();
  const legacy = current.products.map(({plan, brandEvidence, specLabel, ...p}) => p);
  const digest = text => createHash('sha256').update(text).digest('hex');
  const body = JSON.stringify({schemaVersion:1, checkedAt:when(1), products:legacy}) + '\n';
  const {source, ...manifest} = current.manifest;
  Object.assign(manifest, {schemaVersion:1, sha256:digest(body), snapshot:'snapshots/' + digest(body) + '.json',
    semanticHash:digest(JSON.stringify(legacy.map(({observedAt, ...rest}) => rest)))});
  await writeFile(join(f.outputDir, manifest.snapshot), body);
  await writeFile(join(f.outputDir, 'manifest.json'), JSON.stringify(manifest));
  const plus = product(scopes[1], 'older-plus', {name:'ChatGPT Plus 月付成品号 支持 Codex'});
  assert.equal((await f.run(sample(2, [product(scopes[0], 'existing'), plus]))).published, true);
  const upgraded = await f.current();
  assert.equal(upgraded.manifest.schemaVersion, 2);
  assert.equal(upgraded.manifest.source, 'live');
  assert.deepEqual(upgraded.products.find(p => p.plan === 'plus').changes, []);
  assert.equal(await readFile(join(f.outputDir, manifest.snapshot), 'utf8'), body);
});

test('events require complete rounds, known zero inventory and equivalent sale specifications', async t => {
  const f = await fixture(t);
  const soldOut = product(scopes[0], 'existing', { stockCount: 0 });
  await f.run(sample(1, [soldOut]));
  const recovered = { ...soldOut, stockCount: 1, price: 60 };
  const fresh = product(scopes[1], 'new');
  assert.equal((await f.run(sample(2, [recovered, fresh]))).published, true);
  let result = await f.current();
  assert.deepEqual(result.products.find(p => p.goodsKey === 'existing').changes, ['restocked', 'price_drop']);
  assert.deepEqual(result.products.find(p => p.goodsKey === 'new').changes, ['first_seen']);
  // Shops still return original goods, but this time none are Team offers.
  assert.equal((await f.run(sample(3, [product(scopes[0], 'steam', { name: 'Steam 礼品卡' })]))).published, true);
  await f.run(sample(4, [fresh]));
  result = await f.current();
  assert.deepEqual(result.products[0].changes, []);
  const different = { ...fresh, name: fresh.name.replace('1个月', '3个月'), price: 10 };
  await f.run(sample(5, [different]));
  result = await f.current();
  assert.deepEqual(result.products[0].changes, []);
});

test('the public feed only exposes ordinary source image URLs without embedded credentials or query credentials', async t => {
  const f = await fixture(t);
  const plain = 'https://qn.ldxp.cn/ab/shop.png';
  const inputs = [plain, 'https://qn.ldxp.cn/ab/shop.png?access_token=example',
    'https://user:example@qn.ldxp.cn/shop.png', 'https://qn.ldxp.cn/ab/shop.png#fragment', 'javascript:alert(0)',
    'https://elsewhere.invalid/track.png', 'http://qn.ldxp.cn/ab/shop.png'];
  const rows = inputs.map((imageUrl, i) => product(scopes[0], String(i), { imageUrl }));
  assert.equal((await f.run(sample(1, rows))).published, true);
  const result = await f.current();
  assert.deepEqual(result.products.map(p => p.imageUrl), [plain, ...inputs.slice(1).map(() => null)]);
});

test('concurrent runs against the same public directory do not both collect or publish', async t => {
  const f = await fixture(t);
  const gate = Promise.withResolvers(), ready = Promise.withResolvers();
  const job = runHourly({ config, outputDir: f.outputDir, stateDir: f.stateDir, collect: async () => {
    ready.resolve(); await gate.promise; return sample(1);
  } });
  await ready.promise;
  let other;
  try { other = await f.run(sample(2)); }
  finally { gate.resolve(); }
  assert.equal((await job).status, 'success');
  assert.equal(other.status, 'busy');
  assert.equal((await f.current()).manifest.checkedAt, when(1));
});

test('archive replay selects the configured shops, keeps original observation times and separates genuine subscriptions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'offer-archive-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'round.json'), outputDir = join(dir, 'replay');
  const rows = [
    product(scopes[0], 'plus', {name:'ChatGPT Plus 月付成品号 支持 Codex'}),
    product(scopes[0], 'pro', {name:'ChatGPT Pro 月付成品号', stockCount:0}),
    product(scopes[0], 'team'),
    product(scopes[0], 'legacy', {name:'Codex Team 成品账号'}),
    product(scopes[0], 'steam', {name:'Steam 礼品卡'}),
    product(scopes[0], 'k12', {name:'ChatGPT Team K12 成品'}),
    product(scopes[1], 'other', {name:'ChatGPT Pro 20x'}),
  ];
  const archive = { ...sample(1, rows), scopes };
  await writeFile(input, JSON.stringify(archive));
  const options = { input, outputDir, config: { shops: config.shops.slice(0, 1), scopes: scopes.slice(0, 1) } };
  const result = await replayArchive(options);
  assert.equal(result.rawProductCount, 6);
  assert.equal(result.checkedAt, when(1));
  for (const value of Object.values(result.planCounts)) assert.equal(value.products, 1);
  assert.equal(result.planCounts.pro.inStockProducts, 0);
  assert.equal(result.codexTeam, 1);
  const manifest = JSON.parse(await readFile(join(outputDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.source, 'archive');
  const snapshot = JSON.parse(await readFile(join(outputDir, manifest.snapshot), 'utf8'));
  assert.ok(snapshot.products.every(p => p.observedAt === when(1) && p.specLabel));
  assert.equal(snapshot.products.find(p => p.goodsKey === 'plus').brand, 'chatgpt');
  await assert.rejects(replayArchive(options), {code:'EEXIST'});
  const full = await replayArchive({ input, outputDir:join(dir,'all'), scope:'recorded' });
  assert.equal(full.planCounts.pro.shops, 2);
  archive.queries[1].complete = false;
  await writeFile(input, JSON.stringify(archive));
  const broken = join(dir,'incomplete');
  await assert.rejects(replayArchive({ input, outputDir:broken, scope:'recorded' }), /分页/);
  await assert.rejects(readFile(join(broken,'manifest.json')), {code:'ENOENT'});
});
