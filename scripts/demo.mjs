import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createPreviewServer } from './preview.mjs';

// Invented prices and shop identities. These rows never enter the collector.
const samples = [
  { shop: '甲', plan: 'plus', spec: '个人订阅 · 1 个月', group: 'plus-month', price: 90, stock: 4 },
  { shop: '乙', plan: 'plus', spec: '个人订阅 · 1 个月', group: 'plus-month', price: 76, stock: 2 },
  { shop: '乙', plan: 'plus', spec: '个人订阅 · 1 年', group: 'plus-year', price: 800, stock: 1 },
  { shop: '甲', plan: 'pro', spec: '个人订阅 · 1 个月 · 5×', group: 'pro-5x', price: 240, stock: 3 },
  { shop: '丙', plan: 'pro', spec: '个人订阅 · 1 个月 · 20×', group: 'pro-20x', price: 600, stock: 2 },
  { shop: '甲', plan: 'team', spec: '席位 · 1 个月 · 5×', group: 'team-seat-5x', price: 45, stock: 1 },
  { shop: '丙', plan: 'team', spec: '席位 · 1 个月 · 5×', group: 'team-seat-5x', price: 35, stock: 2 },
  { shop: '乙', plan: 'team', spec: '席位 · 期限待核', group: null, price: 12, stock: 0 }
];
const labels = { plus: 'Plus', pro: 'Pro', team: 'Team' };

export function createDemoSnapshot(checkedAt = new Date().toISOString()) {
  const products = samples.map((row, index) => ({
    shopToken: 'demo-' + row.shop, shopName: '示例店' + row.shop, goodsKey: 'sample-' + (index + 1),
    brand: 'chatgpt', plan: row.plan, title: 'ChatGPT ' + labels[row.plan] + ' ' + row.spec,
    specLabel: row.spec, comparisonKey: row.group, form: row.plan === 'team' ? 'seat' : 'subscription',
    price: row.price, priceSymbol: '¥', minQuantity: 1, stockCount: row.stock, inStock: row.stock > 0,
    observedAt: checkedAt
  }));
  const snapshot = { schemaVersion: 2, checkedAt, products };
  const sha256 = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const manifest = { source: 'demo', schemaVersion: 2, checkedAt, snapshot: 'snapshots/' + sha256 + '.json', sha256,
    shopCount: new Set(products.map(p => p.shopToken)).size, productCount: products.length };
  return { manifest, snapshot };
}

export async function startDemo(port = 8770) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口范围为 0 到 65535。');
  const { manifest, snapshot } = createDemoSnapshot();
  const dataDir = await mkdtemp(join(tmpdir(), 'ai-price-demo-'));
  const server = createPreviewServer({ dataDir });
  try {
    await mkdir(join(dataDir, 'snapshots'));
    await writeFile(join(dataDir, manifest.snapshot), JSON.stringify(snapshot));
    await writeFile(join(dataDir, 'manifest.json'), JSON.stringify(manifest));
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
  } catch (e) {
    await rm(dataDir, { recursive: true, force: true });
    throw e;
  }
  return {
    url: 'http://127.0.0.1:' + server.address().port + '/',
    async close() {
      await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { port: { type: 'string' } } });
    const demo = await startDemo(Number(values.port ?? 8770));
    console.log('示例店铺、价格和库存均为虚构。请在浏览器打开 ' + demo.url + '，按 Ctrl+C 关闭。');
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      demo.close().catch(() => { process.exitCode = 1; });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? '端口已被占用。可运行 node scripts/demo.mjs --port 8771。' : error.message);
    process.exitCode = 1;
  }
}
