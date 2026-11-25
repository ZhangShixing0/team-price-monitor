import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readPilotConfig } from '../collector/pilot.mjs';
import { runHourly } from './hourly.mjs';

const key = s => JSON.stringify([s.shopToken, s.goodsType, s.categoryId]);
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
function requireSeparateDirectory(site, target) {
  const path = relative(site, target);
  if (!(path === '..' || path.startsWith('..' + sep) || isAbsolute(path))) {
    throw new Error('历史回放须使用正式站点以外的新目录。');
  }
}

// Use the original plan as the denominator, including categories that returned no items.
function recordedConfig(run) {
  if (!Array.isArray(run.scopes) || !run.scopes.length) throw new Error('归档缺少原始分类计划。');
  const shops = [...new Set(run.scopes.map(s => s.shopToken))];
  if (shops.some(s => typeof s !== 'string' || !s)) throw new Error('归档缺少店铺标识。');
  return { shops: shops.map(shop_token => ({ shop_token })), scopes: run.scopes };
}

function selectPilot(run, config) {
  const planned = new Map(config.scopes.map(s => [key(s), s]));
  const products = [];
  for (const p of run.products) {
    const sources = (p.sourceQueries?.length ? p.sourceQueries : [p])
      .filter(s => planned.has(key({ ...s, shopToken: p.shopToken })));
    if (!sources.length) continue;
    const scope = planned.get(key(p)) || planned.get(key({ ...sources[0], shopToken: p.shopToken }));
    products.push({ ...p, goodsType: scope.goodsType, categoryId: scope.categoryId,
      categoryName: scope.categoryName, sourceQueries: sources });
  }
  return { ...run, products, queries: run.queries.filter(q => planned.has(key(q))), stats: {} };
}

function countPlans(products) {
  return Object.fromEntries(['plus', 'pro', 'team'].map(plan => {
    const rows = products.filter(p => p.brand === 'chatgpt' && p.plan === plan);
    const stocked = rows.filter(p => p.inStock === true);
    return [plan, { products: rows.length, shops: new Set(rows.map(p => p.shopToken)).size,
      inStockProducts: stocked.length, inStockShops: new Set(stocked.map(p => p.shopToken)).size,
      inferredProducts: rows.filter(p => p.brandInferred).length,
      comparableProducts: rows.filter(p => p.comparisonKey !== null).length }];
  }));
}

export async function replayArchive({ input, outputDir, scope = 'pilot', config } = {}) {
  if (!input || !outputDir || !['pilot', 'recorded'].includes(scope)) {
    throw new Error('请指定 --input 历史归档 --output-dir 新目录，可选 --scope pilot 或 recorded。');
  }
  const archive = await readJson(input);
  if (archive.complete !== true || archive.scopedComplete !== true || archive.error ||
      !Array.isArray(archive.queries) || !Array.isArray(archive.products)) throw new Error('需要完整的历史分类核验归档。');
  config ??= scope === 'recorded' ? recordedConfig(archive) : await readPilotConfig();
  const run = scope === 'recorded' ? { ...archive, stats: {} } : selectPilot(archive, config);
  const target = resolve(outputDir);
  const parent = dirname(target);
  const site = await realpath(fileURLToPath(new URL('../site', import.meta.url)));
  requireSeparateDirectory(site, target);
  await mkdir(parent, { recursive: true });
  const canonical = resolve(await realpath(parent), relative(parent, target));
  requireSeparateDirectory(site, canonical);
  await mkdir(target); // exclusive directory creation: never modify a pre-existing destination
  const stateDir = await mkdtemp(join(tmpdir(), 'price-archive-replay-'));
  try {
    const report = await runHourly({ config, outputDir: target, stateDir, source: 'archive', collect: async () => run });
    if (!report.published) throw new Error(report.error || '历史核验未通过。');
    const { products } = await readJson(join(target, report.snapshot));
    return { source: 'archive', scope, checkedFrom: run.startedAt, checkedAt: report.checkedAt,
      shopCount: config.shops.length, scopeCount: config.scopes.length, rawProductCount: report.rawProductCount,
      publicProducts: products.length, planCounts: countPlans(products),
      codexTeam: products.filter(p => p.brand === 'codex').length,
      unconfirmedTeam: products.filter(p => p.brand === 'unknown').length, outputDir: target };
  } finally {
    // mkdtemp created this job-private directory; no shared state or public data live here.
    await rm(stateDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { input: { type: 'string' }, 'output-dir': { type: 'string' }, scope: { type: 'string' } } });
    console.log(JSON.stringify(await replayArchive({ input: values.input, outputDir: values['output-dir'], scope: values.scope }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
