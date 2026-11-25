import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPreviewServer } from '../scripts/preview.mjs';
import { runHourly } from './hourly.mjs';

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
