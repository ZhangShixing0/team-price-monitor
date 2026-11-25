import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { availablePlans, groupQuotes, normalizeProducts } from '../site/catalog-view.mjs';
import { createDemoSnapshot, startDemo } from './demo.mjs';

test('示例含不同规格、同规格双向价格排序和明确的库存状态', () => {
  const { manifest, snapshot } = createDemoSnapshot('2025-01-01T00:00:00.000Z');
  const products = normalizeProducts(snapshot.products, 2);
  assert.equal(manifest.source, 'demo');
  assert.equal(manifest.productCount, 8);
  assert.equal(manifest.shopCount, 3);
  assert.deepEqual(availablePlans(products, 'chatgpt', 2), ['plus', 'pro', 'team']);
  assert.ok(products.every(p => !p.itemUrl && !p.imageUrl && p.shopName.startsWith('示例店')));
  assert.ok(products.some(p => !p.inStock && p.comparisonKey === null));
  const groupPrices = order => groupQuotes(products, order, p => p.observedAt)
    .find(g => g.products[0].comparisonKey === 'plus-month').products.map(p => p.price);
  assert.deepEqual(groupPrices('price_asc'), [76, 90]);
  assert.deepEqual(groupPrices('price_desc'), [90, 76]);
});

test('离线入口可从临时示例目录提供真实页面、索引及内容校验一致的报价', async t => {
  const demo = await startDemo(0);
  t.after(() => demo.close());
  const page = await (await fetch(demo.url)).text();
  assert.match(page, /AI 订阅比价/u);
  const manifest = await (await fetch(new URL('data/manifest.json', demo.url))).json();
  const snapshot = await (await fetch(new URL('data/' + manifest.snapshot, demo.url))).text();
  assert.equal(manifest.sha256, createHash('sha256').update(snapshot).digest('hex'));
  assert.deepEqual(JSON.parse(snapshot), createDemoSnapshot(manifest.checkedAt).snapshot);
  assert.equal((await fetch(new URL('data/private.json', demo.url))).status, 404);
});
