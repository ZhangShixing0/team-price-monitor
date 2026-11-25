const digestPattern = /^[0-9a-f]{64}$/;
const hashPath = /^\/data\/snapshots\/([0-9a-f]{64})\.json$/;
const byteLimit = 8 * 1024 * 1024;
const utf8 = new TextEncoder();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireValue(condition, message) {
  if (!condition) throw new HttpError(400, message);
}

async function digest(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(text))),
    byte => byte.toString(16).padStart(2, '0')).join('');
}

async function authorized(request, token) {
  const supplied = request.headers.get('authorization') || '';
  if (!token || !supplied.startsWith('Bearer ') || supplied.length > 2048) return false;
  const [left, right] = await Promise.all([digest(supplied.slice(7)), digest(token)]);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function readLimited(request) {
  if (Number(request.headers.get('content-length')) > byteLimit) throw new HttpError(413, '上传内容过大');
  if (!request.body) throw new HttpError(400, '缺少发布数据');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > byteLimit) {
      await reader.cancel();
      throw new HttpError(413, '上传内容过大');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch { throw new HttpError(400, '文件不是有效 JSON'); }
}
const onlyKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key));
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const count = value => Number.isSafeInteger(value) && value >= 0;
const nonempty = value => typeof value === 'string' && value.length > 0;
const boundedManifestKeys = ['schemaVersion', 'checkedFrom', 'checkedAt', 'shopCount', 'scopeCount',
  'productCount', 'snapshot', 'sha256', 'semanticHash', 'seenHash', 'historyComplete', 'source'];

function validateManifest(m) {
  requireValue(onlyKeys(m, boundedManifestKeys) &&
    ((m.schemaVersion === 1 && m.source === undefined) || (m.schemaVersion === 2 && m.source === 'live')) &&
    date(m.checkedFrom) && date(m.checkedAt) && m.checkedFrom <= m.checkedAt &&
    Date.parse(m.checkedAt) <= Date.now() + 300000 &&
    count(m.shopCount) && m.shopCount > 0 && count(m.scopeCount) && m.scopeCount >= m.shopCount &&
    count(m.productCount) && digestPattern.test(m.sha256) &&
    m.snapshot === 'snapshots/' + m.sha256 + '.json' &&
    digestPattern.test(m.semanticHash) && digestPattern.test(m.seenHash) && typeof m.historyComplete === 'boolean',
    '报价清单字段或时间无效');
}

const productFields = ['shopToken', 'shopName', 'goodsKey', 'title', 'price', 'priceSymbol', 'stockCount',
  'minQuantity', 'inStock', 'brand', 'brandInferred', 'form', 'imageUrl', 'itemUrl', 'observedAt',
  'comparisonKey', 'specificationHash', 'changes', 'previousPrice'];
const v2ProductFields = [...productFields, 'plan', 'brandEvidence', 'specLabel'];
function validPlanFields(p) {
  if (!['plus', 'pro', 'team'].includes(p.plan) || !nonempty(p.specLabel)) return false;
  if (p.brand === 'chatgpt') return ['title', 'description', 'category'].includes(p.brandEvidence) &&
    p.brandInferred === (p.brandEvidence !== 'title');
  return p.plan === 'team' && p.brandEvidence === null && p.brandInferred === false && p.comparisonKey === null;
}
async function validateSnapshot(m, text) {
  requireValue(typeof text === 'string' && await digest(text) === m.sha256, '报价文件校验和不匹配');
  const s = parseJson(text);
  requireValue(onlyKeys(s, ['schemaVersion', 'checkedAt', 'products']) && s.schemaVersion === m.schemaVersion &&
    date(s.checkedAt) && s.checkedAt <= m.checkedAt && Array.isArray(s.products) &&
    s.products.length === m.productCount, '报价条数或版本无效');
  const ids = new Set();
  const shops = new Set();
  for (const p of s.products) {
    requireValue(onlyKeys(p, s.schemaVersion === 2 ? v2ProductFields : productFields) &&
      (s.schemaVersion === 1 || validPlanFields(p)) && nonempty(p.shopToken) && nonempty(p.goodsKey) && nonempty(p.title) &&
      typeof p.shopName === 'string' && typeof p.priceSymbol === 'string' &&
      (p.price === null || (Number.isFinite(p.price) && p.price >= 0)) &&
      (p.stockCount === null || count(p.stockCount)) && count(p.minQuantity) && p.minQuantity > 0 &&
      (p.inStock === null || typeof p.inStock === 'boolean') &&
      (p.inStock !== true || (count(p.stockCount) && p.stockCount >= p.minQuantity)) &&
      ['chatgpt','codex','unknown'].includes(p.brand) && typeof p.brandInferred === 'boolean' &&
      typeof p.form === 'string' && (p.imageUrl == null || typeof p.imageUrl === 'string') &&
      p.itemUrl === 'https://wzyp.cn/item/' + encodeURIComponent(p.goodsKey) &&
      date(p.observedAt) && p.observedAt <= s.checkedAt && Array.isArray(p.changes) &&
      p.changes.every(value => ['first_seen','restocked','price_drop'].includes(value)) &&
      (p.comparisonKey == null || typeof p.comparisonKey === 'string') &&
      (p.specificationHash == null || digestPattern.test(p.specificationHash)) &&
      (p.previousPrice === undefined || Number.isFinite(p.previousPrice)), '报价字段无效');
    const id = JSON.stringify([p.shopToken, p.goodsKey]);
    requireValue(!ids.has(id), '存在重复商品');
    ids.add(id);
    shops.add(p.shopToken);
  }
  requireValue(shops.size <= m.shopCount, '报价店铺数超出核验范围');
  const semantic = JSON.stringify(s.products.map(({ observedAt, ...values }) => values));
  requireValue(await digest(semantic) === m.semanticHash, '报价内容摘要不匹配');
}

async function inspectPointer(bucket, manifest) {
  const current = await bucket.get('manifest.json');
  if (!current) return { condition: new Headers({ 'If-None-Match': '*' }) };
  const old = await current.json();
  validateManifest(old);
  if (old.schemaVersion > manifest.schemaVersion) throw new HttpError(409, '站点已升级，请使用新版采集程序发布。');
  if (boundedManifestKeys.every(key => old[key] === manifest[key])) return { same: true };
  if (manifest.checkedFrom < old.checkedAt || manifest.checkedAt <= old.checkedAt) {
    throw new HttpError(409, '站点已有同轮或更新的完整报价');
  }
  return { condition: { etagMatches: current.etag } };
}

async function publish(request, env) {
  if (!await authorized(request, env.PUBLISH_TOKEN)) throw new HttpError(401, '无发布权限');
  const envelope = parseJson(await readLimited(request));
  requireValue(onlyKeys(envelope, ['manifest', 'snapshot']), '上传格式无效');
  const m = envelope.manifest;
  validateManifest(m);
  const bucket = env.QUOTES;
  const prior = await inspectPointer(bucket, m);
  const receipt = { published: true, sha256: m.sha256, checkedAt: m.checkedAt };
  if (prior.same) return { ...receipt, unchanged: true };
  const stored = await bucket.get(m.snapshot);
  if (!stored && typeof envelope.snapshot !== 'string') throw new HttpError(428, '需要上传报价文件');
  const text = stored ? await stored.text() : envelope.snapshot;
  await validateSnapshot(m, text);
  if (!stored) {
    // Concurrent writers for the same SHA have already verified the exact same bytes.
    const created = await bucket.put(m.snapshot, text, { onlyIf: new Headers({ 'If-None-Match': '*' }),
      httpMetadata: { contentType: 'application/json; charset=utf-8' } });
    if (!created && !await bucket.head(m.snapshot)) throw new HttpError(503, '报价文件未写入');
  }
  const committed = await bucket.put('manifest.json', JSON.stringify(m) + '\n', { onlyIf: prior.condition,
    httpMetadata: { contentType: 'application/json; charset=utf-8' } });
  if (!committed) {
    if ((await inspectPointer(bucket, m)).same) return { ...receipt, unchanged: true };
    throw new HttpError(409, '发布期间版本已改变，请重试');
  }
  return { ...receipt, unchanged: false };
}

const json = (value, status) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/_publish') {
        if (url.protocol !== 'https:') throw new HttpError(400, '发布需要 HTTPS');
        if (request.method !== 'POST') throw new HttpError(405, '仅接受 POST');
        return json(await publish(request, env), 200);
      }
      if (url.pathname.startsWith('/data/')) {
        if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, '仅支持读取');
        const isManifest = url.pathname === '/data/manifest.json';
        if (!isManifest && !hashPath.test(url.pathname)) throw new HttpError(404, '文件不存在');
        const key = url.pathname.slice(6);
        const obj = request.method === 'HEAD' ? await env.QUOTES.head(key) : await env.QUOTES.get(key);
        if (!obj) throw new HttpError(404, '报价尚未发布');
        const headers = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
          'Cache-Control': isManifest ? 'no-cache' : 'public, max-age=31536000, immutable',
          'ETag': obj.httpEtag };
        if (request.headers.get('If-None-Match') === obj.httpEtag) return new Response(null, { status: 304, headers });
        return new Response(request.method === 'HEAD' ? null : obj.body, { headers });
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error instanceof HttpError ? error.message : '站点存储暂时不可用' },
        error instanceof HttpError ? error.status : 503);
    }
  },
};
