// Public category reads only. The browser/visitor header stays inside collector.
import { randomUUID } from 'node:crypto';
import { normalizeProductImageUrl } from './product-image.mjs';

const TYPES = new Set(['card', 'article', 'resource', 'equity']);
const key = s => JSON.stringify([s.shopToken, s.goodsType, s.categoryId]);
const safeError = e => String(e?.message || e).replace(/wss?:\/\/[^\s]+/g, '[本地浏览器连接]').split('Call log:')[0].slice(0, 600);
// Only an explicit HTTP-200 business response can be isolated. Auth/access and
// transport errors always stop the whole run even if they also mention closure.
export function isScopeUnavailableResponse(request) {
  if (request?.httpStatus !== 200 || !['string', 'number'].includes(typeof request.code)) return false;
  const code = Number(request.code);
  if (!Number.isFinite(code) || code === 1 || code >= 500 || [401, 403, 429].includes(code)) return false;
  const message = String(request.businessMessage || '');
  const context = `${message} ${request.error || ''}`;
  if (/登录|登入|权限|验证|人机|限流|频繁|访问.{0,8}(?:限制|拒绝)|安全检查|login|log\s*in|sign\s*in|captcha|challenge|unauthorized|forbidden|access.?denied|rate.?limit|too many/iu.test(context)) return false;
  return /(?:店铺|商店|商户).{0,8}(?:不存在|已关闭|已注销|已停用|已禁用|已打烊)|(?:不存在|已关闭|已注销|已打烊).{0,4}(?:店铺|商店|商户)|(?:分类|类目).{0,8}(?:不存在|已删除|已关闭|已停用|已禁用)|(?:不存在|已删除).{0,4}(?:分类|类目)/u.test(message);
}
export function publicRecord(p, scope, observedAt) {
  const record = { ...p, shopToken: scope.shopToken, shopName: scope.shopName || scope.shopToken,
    imageUrl: normalizeProductImageUrl(p.imageUrl),
    categoryId: scope.categoryId || p.declaredCategoryId || 0,
    categoryName: scope.categoryId ? scope.categoryName || '' : p.declaredCategoryName || '全部分类',
    observedAt, itemUrl: `https://wzyp.cn/item/${p.goodsKey}`,
    available: p.status === 0 || p.status === '0' ? false : p.stockState === 'unknown' ? null : p.stockCount > 0,
    stockSource: scope.categoryId ? 'category_scoped' : 'all_categories',
    sourceQueries: [{ goodsType: scope.goodsType, categoryId: scope.categoryId }] };
  if (scope.categoryId === 0 && p.stockCount === 0) {
    record.aggregateStockCount = 0; record.stockCount = null; record.stockState = 'unknown';
    record.available = p.status === 0 || p.status === '0' || p.listed === false ? false : null;
  }
  return record;
}
function includeProducts(map, products, scope, observedAt, scopeRows) {
  for (const p of products) {
    if (!p.goodsKey || !/^[A-Za-z0-9_.-]+$/.test(p.goodsKey)) throw new Error('公开商品编号缺失或异常。');
    const record = publicRecord(p, scope, observedAt), id = JSON.stringify([scope.shopToken, p.goodsKey]), old = map.get(id);
    scopeRows?.push(record);
    const sources = [...new Map([...(old?.sourceQueries || []), ...record.sourceQueries].map(s => [JSON.stringify(s), s])).values()];
    map.set(id, old?.stockSource === 'category_scoped' && !scope.categoryId ? { ...old, sourceQueries: sources } : { ...record, sourceQueries: sources });
  }
}
async function prepare(c, run, onProgress, beforeInit = () => {}) {
  run.selectedShopCount = c.allowedTokens.size;
  beforeInit();
  await c.init(onProgress, { deadlineAt: run.deadlineAt, signal: run._signal });
  run.networkStartedAt = new Date().toISOString();
}
function validate(c, scope, pageSize) {
  if (!c.allowedTokens.has(scope.shopToken) || !TYPES.has(scope.goodsType) || !Number.isSafeInteger(scope.categoryId) || scope.categoryId < 0) throw new Error('公开读取范围无效。');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('每页最多100件。');
}
function newRun(mode) {
  const requests = [];
  let counted = 0, measuredRequests = 0, transferBytes = 0;
  function traffic() {
    while (counted < requests.length) {
      const row = requests[counted++];
      const timing = row.timing;
      if (Number.isSafeInteger(timing?.transferBytes) && timing.transferBytes >= 0
          && Number.isSafeInteger(row.decodedBytes) && timing.decodedBodyBytes === row.decodedBytes) {
        measuredRequests++;
        transferBytes += timing.transferBytes;
      }
    }
    return { requestCount: counted, measuredRequests, transferBytes, transferMeasurementComplete: counted > 0 && measuredRequests === counted };
  }
  return { runId: randomUUID(), mode, startedAt: new Date().toISOString(), complete: false, publicComplete: false, scopedComplete: false, rediscover: false, products: [], shops: [], scopes: [], queries: [], requests, stats: {}, traffic };
}
async function finish(c, run, products, started, onProgress) {
  run.finishedAt = new Date().toISOString(); run.products = [...products.values()];
  const attempted = new Set(run.requests.map(r => r.body.token));
  run.shops = [...attempted].map(shopToken => ({ shopToken, shopName: run.scopes.find(s => s.shopToken === shopToken)?.shopName || shopToken, complete: false, publicComplete: false }));
  const traffic = run.traffic();
  delete run.traffic;
  run.stats = { elapsedMs: Date.now() - started, readWallMs: run.networkStartedAt ? Date.now() - Date.parse(run.networkStartedAt) : null,
    ...traffic, successfulRequests: run.requests.filter(r => r.code === 1 && !r.error).length,
    encodedBodyBytes: run.requests.reduce((n,r) => n + (r.timing?.encodedBodyBytes || 0),0),
    decodedBodyBytes: run.requests.reduce((n,r) => n + (r.decodedBytes || 0),0),
    totalScopes: run.scopes.length,
    completedScopes: run.mode === 'discovery' ? (run.discoveryResults || []).filter(r=>r.success).length : run.queries.filter(q => q.complete).length, attemptedShops: attempted.size, totalShops:run.selectedShopCount || 0,
    productCount: run.products.length, queryCount: run.queries.length, completeQueries: run.queries.filter(q => q.complete).length,
    concurrency:run.concurrency || 1, minimumRequestIntervalMs:c.minimumIntervalMs, initializationExcludedFromReadWall:true,
    budgetMs:run.budgetMs ?? null, budgetExceeded:run.budgetExceeded === true, unattemptedScopes:run.scopes.length - run.queries.filter(q => q.attempted !== false).length,
    unavailableShops:run._unavailableShops?.size || 0, unavailableScopes:run.queries.filter(q => q.errorCode === 'scope_unavailable').length };
  if (run._unavailableShops?.size) run.unavailableShops = [...run._unavailableShops].map(([shopToken, message]) => ({ shopToken, message }));
  c.busy = false;
  onProgress({ phase:run.complete ? 'completed' : 'incomplete',mode:run.mode,...run.stats,message:run.error || (run.mode === 'discovery' ? '本批目录巡检完成；尚不代表全站新货已检查。' : run.complete ? '本次相关分类更新完成。' : run.stats.unavailableScopes ? `${run.stats.unavailableScopes} 个分类暂不可用；其他店铺已继续读取，未完成范围保留旧记录。` : '本次分类读取未完整完成，未完成范围保留旧记录。') });
  return run;
}
export async function collectScopes(c, { scopes = [], query = '', pageSize = 100, concurrency = 1, budgetMs = null, signal, onProgress = () => {}, onScopeComplete } = {}) {
  if(c.busy) throw new Error('已有采集进行中。'); c.busy=true;
  const run=newRun('targeted'), products=new Map(), started=Date.now();
  run.query=String(query).slice(0,300); run.scopes=[...new Map(scopes.map(s => [key(s),s])).values()];
  run.concurrency = concurrency;
  run.isolateUnavailableScopes = true;
  const unavailableShops = new Map();
  Object.defineProperty(run, '_unavailableShops', { value: unavailableShops });
  if (budgetMs !== null) { run.budgetMs = budgetMs; run.deadlineAt = started + budgetMs; }
  Object.defineProperty(run, '_signal', { value: signal });
  const checkStop = () => {
    if (run.stopRequested) throw new Error(run.stopRequested);
    if (signal?.aborted) { const error = new Error('本轮读取已取消，未完成范围保留旧数据。'); error.code = 'COLLECTION_ABORTED'; throw error; }
    if (run.deadlineAt && Date.now() >= run.deadlineAt) { const error = new Error('本轮读取达到时间预算，未完成范围保留旧数据。'); error.code = 'COLLECTION_BUDGET'; throw error; }
  };
  const stop = error => {
    if (error.code === 'COLLECTION_BUDGET' || run.deadlineAt && Date.now() >= run.deadlineAt) run.budgetExceeded = true;
    if (error.code === 'COLLECTION_ABORTED' || signal?.aborted) run.cancelled = true;
    run.error ||= safeError(error);
    run.stopRequested ||= run.error;
  };
  const checkShop = shopToken => {
    if (!unavailableShops.has(shopToken)) return;
    const error = new Error(unavailableShops.get(shopToken)); error.code = 'SCOPE_UNAVAILABLE'; throw error;
  };
  const markUnavailable = (scope, query, error) => {
    const request = error.publicRequest;
    if (request && (request.body?.token !== scope.shopToken || !isScopeUnavailableResponse(request))) return false;
    if (error.code !== 'SCOPE_UNAVAILABLE' || !unavailableShops.has(scope.shopToken) && !request) return false;
    const message = unavailableShops.get(scope.shopToken) || safeError(request?.businessMessage || error);
    unavailableShops.set(scope.shopToken, message);
    Object.assign(query, { complete: false, errorCode: 'scope_unavailable', error: message, retryable: true });
    return true;
  };
  try {
    if(!run.scopes.length || (budgetMs === null && run.scopes.length > 500)) throw new Error('相关分类为空或超出范围；请使用目录巡检。');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('分类并发数须为 1 至 3。');
    if (budgetMs !== null && (!Number.isSafeInteger(budgetMs) || budgetMs < 1)) throw new Error('时间预算须为正整数毫秒。');
    checkStop();
    await prepare(c,run,onProgress, () => { for (const scope of run.scopes) validate(c,scope,pageSize); });
    checkStop();
    run.queries = run.scopes.map(scope => ({ ...scope, attempted:false, complete:false, pages:0, total:null, uniqueCount:0 }));
    let nextScope = 0;
    const readScope = async (scope, q, index) => {
      checkStop(); checkShop(scope.shopToken); q.attempted = true;
      const progress = () => onProgress({ phase:'collecting', mode:'targeted', totalScopes:run.scopes.length, completedScopes:run.queries.filter(q => q.complete).length, ...run.traffic(), message:`更新相关分类 ${index+1}/${run.scopes.length}：${scope.categoryName || scope.categoryId}` });
      progress();
      let expectedPages=1, effectiveSize=pageSize; const rows=[], totals=[];
      const scopeRows = onScopeComplete ? [] : undefined;
      for(let current=1; current<=expectedPages; current++) {
        checkStop(); checkShop(scope.shopToken);
        if(current>2000) throw new Error('单分类分页超出上限。');
        let result=await c.read('/shopApi/Shop/goodsList',{token:scope.shopToken,keywords:'',category_id:scope.categoryId,goods_type:scope.goodsType,current,pageSize:effectiveSize},run);
        checkShop(scope.shopToken);
        if(!Number.isSafeInteger(result.total)||result.total<0) throw new Error('商品总数异常。');
        // Detect a server page-size cap instead of silently skipping rows.
        if(current===1 && result.products.length>0 && result.products.length<effectiveSize && result.total>result.products.length) {
          effectiveSize=result.products.length; q.pageSizeFallback=effectiveSize;
          checkStop(); checkShop(scope.shopToken);
          result=await c.read('/shopApi/Shop/goodsList',{token:scope.shopToken,keywords:'',category_id:scope.categoryId,goods_type:scope.goodsType,current:1,pageSize:effectiveSize},run);
          checkShop(scope.shopToken);
        }
        if(current===1) expectedPages=Math.max(1,Math.ceil(result.total/effectiveSize));
        const at=new Date().toISOString(); includeProducts(products,result.products,scope,at,scopeRows);
        rows.push(...result.products.map(p=>p.goodsKey)); totals.push(result.total); q.pages++;
        if (current < expectedPages) progress();
        if(!result.products.length && result.total>0) {q.error='分页提前为空';break;}
      }
      q.pageSize=effectiveSize; q.total=totals[0]; q.uniqueCount=new Set(rows).size; q.returnedRows=rows.length; q.totalChanged=new Set(totals).size!==1;
      q.complete=!q.error&&!q.totalChanged&&q.uniqueCount===q.total&&rows.length===q.uniqueCount;
      if(!q.complete) q.error||='读取期间分页数量变化或重复，保留旧记录等待复核。';
      if (q.complete && onScopeComplete) onScopeComplete(q, scopeRows);
    };
    const worker = async () => {
      while (!run.stopRequested && nextScope < run.scopes.length) {
        const index = nextScope++;
        try { await readScope(run.scopes[index], run.queries[index], index); }
        catch (error) { if (!markUnavailable(run.scopes[index], run.queries[index], error)) { run.queries[index].error = safeError(error); stop(error); } }
      }
    };
    await Promise.all(Array.from({ length:Math.min(concurrency, run.scopes.length) }, worker));
    run.complete=!run.error&&run.queries.length===run.scopes.length&&run.queries.every(q=>q.complete); run.scopedComplete=run.complete;
  }catch(error){stop(error);}
  return finish(c,run,products,started,onProgress);
}
