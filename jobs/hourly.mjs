import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { classifyProduct } from '../collector/classifier.mjs';
import { collectPilot, isPublicTeamOffer, readPilotConfig } from '../collector/pilot.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const scopeKey = q => JSON.stringify([q.shopToken, q.goodsType, q.categoryId]);
const productKey = p => JSON.stringify([p.shopToken, p.goodsKey]);
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const digestPattern = /^[a-f0-9]{64}$/;
const imageHosts = new Set(['qn.ldxp.cn', 'www.ldxp.cn', 'wzyp.cn']);

function publicThumbnail(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    // All currently observed source thumbnails have plain HTTPS paths. Signed
    // queries, fragments and merchant-supplied external URLs stay out of the feed.
    if (url.protocol !== 'https:' || !imageHosts.has(url.hostname) || url.port || url.username ||
        url.password || url.search || url.hash) return null;
    return url.href;
  } catch { return null; }
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, value, { flag: 'wx' });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function readOptional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// An OS-managed SQLite write lock is released even if the publisher is killed.
// Every publisher on this host with the same output directory uses the same lock.
async function acquireLock(outputDir) {
  const canonical = await realpath(outputDir);
  const id = hash(process.platform === 'win32' ? canonical.toLowerCase() : canonical);
  const path = join(tmpdir(), 'team-price-hourly-' + id + '.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    return db;
  } catch (error) {
    db.close();
    if (error.errcode === 5 || error.errcode === 6) return null;
    throw error;
  }
}

async function readBaseline(outputDir, stateDir) {
  const text = await readOptional(join(outputDir, 'manifest.json'));
  if (text === null) return { manifest: null, products: [], seen: new Set(), hasHistory: true };
  const manifest = JSON.parse(text);
  if (!digestPattern.test(manifest.sha256) || manifest.snapshot !== 'snapshots/' + manifest.sha256 + '.json' ||
      !digestPattern.test(manifest.seenHash) || !validDate(manifest.checkedAt) || !validDate(manifest.checkedFrom) ||
      Date.parse(manifest.checkedFrom) > Date.parse(manifest.checkedAt)) {
    throw new Error('已有网站清单格式无法验证，保留原版。');
  }
  const contents = await readFile(join(outputDir, manifest.snapshot), 'utf8');
  if (hash(contents) !== manifest.sha256) throw new Error('上版报价文件校验失败。');
  const { products } = JSON.parse(contents);
  if (!Array.isArray(products) || products.length !== manifest.productCount) throw new Error('上版报价条数无法验证。');
  const ledger = await readOptional(join(stateDir, 'history', manifest.seenHash + '.json'));
  if (ledger !== null && hash(ledger) !== manifest.seenHash) throw new Error('商品发现历史校验失败。');
  // A copied website without its private history still supports restock/price
  // comparisons. Do not claim a previously removed item has never been seen.
  return { manifest, products, seen: new Set(ledger === null ? products.map(productKey) : JSON.parse(ledger)),
    hasHistory: ledger !== null && manifest.historyComplete === true };
}

function checkCoverage(run, config) {
  const planned = new Map(config.scopes.map(scope => [scopeKey(scope), scope]));
  if (!planned.size || planned.size !== config.scopes.length || !run.complete || !run.scopedComplete || run.error ||
      !validDate(run.startedAt) || !validDate(run.finishedAt) || !Array.isArray(run.products) || !Array.isArray(run.queries)) {
    throw new Error(run.error || '本轮分类未完整核验。');
  }
  const observed = new Map();
  for (const p of run.products) {
    if (!/^[A-Za-z0-9_.-]+$/.test(p.goodsKey || '') || !validDate(p.observedAt) ||
        Date.parse(p.observedAt) < Date.parse(run.startedAt) || Date.parse(p.observedAt) > Date.parse(run.finishedAt)) {
      throw new Error('商品标识或逐条核验时间无效。');
    }
    const sources = p.sourceQueries?.length ? p.sourceQueries : [p];
    for (const source of sources) {
      const key = scopeKey({ ...source, shopToken: p.shopToken });
      if (!planned.has(key)) throw new Error('结果含计划外分类。');
      if (!observed.has(key)) observed.set(key, new Set());
      observed.get(key).add(p.goodsKey);
    }
  }
  const verified = new Set();
  for (const q of run.queries) {
    const key = scopeKey(q);
    if (!planned.has(key) || verified.has(key) || q.complete !== true || q.totalChanged || !Number.isSafeInteger(q.total) ||
        q.pages < 1 || !Number.isSafeInteger(q.pages) || q.total !== q.uniqueCount || q.total !== q.returnedRows ||
        q.total !== (observed.get(key)?.size || 0)) throw new Error('分类分页或商品清单与计划不符。');
    verified.add(key);
  }
  if (planned.size !== verified.size) throw new Error('部分计划分类没有返回核验结果。');
}

function publicOffers(run, previous) {
  const oldRows = new Map(previous.products.map(p => [productKey(p), p]));
  const products = [];
  const ids = new Set();
  for (const raw of run.products) {
    const c = classifyProduct(raw);
    if (!isPublicTeamOffer({ ...raw, classification: c })) continue;
    const id = productKey(raw);
    if (ids.has(id)) throw new Error('报价商品编号重复。');
    ids.add(id);
    const stockCount = Number.isSafeInteger(raw.stockCount) && raw.stockCount >= 0 ? raw.stockCount : null;
    const minQuantity = Number.isSafeInteger(raw.minQuantity) && raw.minQuantity > 0 ? raw.minQuantity : 1;
    const unavailable = raw.available === false || raw.listed === false || raw.status === 0 || raw.status === '0';
    const inStock = unavailable ? false : stockCount === null ? null : stockCount >= minQuantity;
    const price = Number.isFinite(raw.price) && raw.price >= 0 ? raw.price : null;
    const old = oldRows.get(id);
    const changes = [];
    if (previous.manifest && previous.hasHistory && !previous.seen.has(id)) changes.push('first_seen');
    if (old?.stockCount === 0 && inStock === true) changes.push('restocked');
    const comparisonKey = c.comparable ? c.comparisonKey : null;
    const historyKey = comparisonKey || c.declaredPriceHistoryKey;
    const specificationHash = historyKey ? hash(JSON.stringify([raw.name, raw.descriptionText || '', historyKey, raw.priceSymbol, minQuantity])) : null;
    if (inStock === true && specificationHash && old?.specificationHash === specificationHash &&
        Number.isFinite(old.price) && price !== null && price < old.price) changes.push('price_drop');
    products.push({ shopToken: raw.shopToken, shopName: raw.shopName, goodsKey: raw.goodsKey, title: raw.name,
      price, priceSymbol: raw.priceSymbol || '', stockCount, minQuantity, inStock,
      brand: c.inferredBrand || c.brand || 'unknown', brandInferred: Boolean(c.inferredBrand), form: c.form || 'unknown',
      imageUrl: publicThumbnail(raw.imageUrl), itemUrl: 'https://wzyp.cn/item/' + encodeURIComponent(raw.goodsKey), observedAt: raw.observedAt,
      comparisonKey, specificationHash, changes, ...(changes.includes('price_drop') ? { previousPrice: old.price } : {}) });
  }
  return products.sort((a, b) => productKey(a) < productKey(b) ? -1 : 1);
}

async function publish(run, config, outputDir, stateDir, previous) {
  checkCoverage(run, config);
  const start = Date.parse(run.startedAt), end = Date.parse(run.finishedAt);
  const publishedAt = previous.manifest ? Date.parse(previous.manifest.checkedAt) : null;
  if (end < start || end > Date.now() || (publishedAt !== null && (start < publishedAt || end <= publishedAt))) {
    throw new Error('本轮核验时间无效、重复或与已发布轮次重叠。');
  }
  if (previous.products.length && run.products.length === 0) {
    throw new Error('所有原店分类同时返回零行，暂缓发布；沿用上次报价。');
  }
  const products = publicOffers(run, previous);
  const semanticHash = hash(JSON.stringify(products.map(({ observedAt, ...values }) => values)));
  let sha256 = previous.manifest?.sha256;
  if (previous.manifest?.semanticHash !== semanticHash) {
    const file = JSON.stringify({ schemaVersion: 1, checkedAt: run.finishedAt, products }) + '\n';
    sha256 = hash(file);
    await atomicWrite(join(outputDir, 'snapshots', sha256 + '.json'), file);
  }
  const seen = new Set([...previous.seen, ...products.map(productKey)]);
  const ledger = JSON.stringify([...seen].sort());
  const seenHash = hash(ledger);
  if (previous.manifest?.seenHash !== seenHash || !previous.hasHistory) {
    await atomicWrite(join(stateDir, 'history', seenHash + '.json'), ledger);
  }
  const manifest = { schemaVersion: 1, checkedFrom: run.startedAt, checkedAt: run.finishedAt,
    shopCount: config.shops.length, scopeCount: config.scopes.length, productCount: products.length,
    snapshot: 'snapshots/' + sha256 + '.json', sha256, semanticHash, seenHash, historyComplete: previous.hasHistory };
  // Commit point: the immutable file and the discovery ledger both exist.
  await atomicWrite(join(outputDir, 'manifest.json'), JSON.stringify(manifest) + '\n');
  return { manifest, fileChanged: !previous.manifest || sha256 !== previous.manifest.sha256 };
}

export async function runHourly({ config, outputDir = join(root, 'site', 'data'), stateDir = join(root, '.state'), collect = collectPilot, signal } = {}) {
  config ??= await readPilotConfig();
  await mkdir(outputDir, { recursive: true });
  const lock = await acquireLock(outputDir);
  if (!lock) return { status: 'busy', published: false, error: '另一个发布任务正在运行。' };
  const start = Date.now();
  const report = { status: 'failed', published: false, startedAt: new Date(start).toISOString(), totalShops: config.shops.length,
    totalScopes: config.scopes.length, completedShops: 0, completedScopes: 0, requestCount: 0, measuredRequests: 0,
    transferBytes: null, transferMeasurementComplete: false, elapsedMs: 0 };
  try {
    const previous = await readBaseline(outputDir, stateDir);
    const run = await collect({ config, signal });
    const queries = run.queries || [];
    const completed = new Set(queries.filter(q => q.complete).map(scopeKey));
    report.completedScopes = config.scopes.filter(q => completed.has(scopeKey(q))).length;
    const incompleteShops = new Set(config.scopes.filter(q => !completed.has(scopeKey(q))).map(q => q.shopToken));
    report.completedShops = new Set(config.scopes.filter(q => !incompleteShops.has(q.shopToken)).map(q => q.shopToken)).size;
    const stats = run.stats || {};
    Object.assign(report, { runId: run.runId, collectionMs: stats.elapsedMs ?? null, requestCount: stats.requestCount || 0,
      measuredRequests: stats.measuredRequests || 0, transferBytes: stats.measuredRequests ? stats.transferBytes : null,
      browserResponseBytes: stats.browserResponseBytes ?? null, browserFinishedRequests: stats.browserFinishedRequests ?? null,
      browserFailedRequests: stats.browserFailedRequests ?? null,
      transferMeasurementComplete: stats.transferMeasurementComplete === true, rawProductCount: run.products?.length ?? 0 });
    if (signal?.aborted) throw new Error('本轮已取消。');
    const { manifest, fileChanged } = await publish(run, config, outputDir, stateDir, previous);
    Object.assign(report, { status: 'success', published: true, checkedAt: manifest.checkedAt, snapshot: manifest.snapshot,
      fileChanged, productCount: manifest.productCount });
  } catch (error) {
    report.error = String(error.message || error).slice(0, 700);
  } finally {
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.now() - start;
    try {
      await atomicWrite(join(stateDir, 'last-run.json'), JSON.stringify(report, null, 2) + '\n');
    } catch (error) {
      // The public commit may already have succeeded; never report it as rolled back.
      report.reportError = String(error.message).slice(0, 300);
    } finally { lock.close(); }
  }
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { 'output-dir': { type: 'string' }, 'state-dir': { type: 'string' } } });
    const result = await runHourly({ outputDir: values['output-dir'], stateDir: values['state-dir'] });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'success' && !result.reportError ? 0 : result.status === 'busy' ? 2 : 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', published: false, error: String(error.message) }));
    process.exitCode = 1;
  }
}
