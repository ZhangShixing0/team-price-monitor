import { normalizeProductImageUrl } from './product-image.mjs';
import { isScopeUnavailableResponse } from './scoped-collector.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeError = error => String(error?.message || error)
  .replace(/wss?:\/\/[^\s]+/gu, '[browser]')
  .split('Call log:')[0].slice(0, 500);
function checkRequestBudget(run = {}) {
  if (run.stopRequested) throw new Error(run.stopRequested);
  if (run._signal?.aborted || run.signal?.aborted) {
    const error = new Error('本轮读取已取消，未完成范围保留旧数据。'); error.code = 'COLLECTION_ABORTED'; throw error;
  }
  if (run.deadlineAt && Date.now() >= run.deadlineAt) {
    const error = new Error('本轮读取达到时间预算，未完成范围保留旧数据。'); error.code = 'COLLECTION_BUDGET'; throw error;
  }
}
const requestTimeout = (run, maximum) => { checkRequestBudget(run); return run.deadlineAt ? Math.max(1, Math.min(maximum, run.deadlineAt - Date.now())) : maximum; };


export class PublicListReader {
  async acquireRequestSlot(run) {
    // Reserve a start slot before waiting. Concurrent workers cannot all wake
    // from the same old lastRequestAt and issue a burst together.
    const previous = this.requestGate;
    let release;
    this.requestGate = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      for (;;) {
        checkRequestBudget(run);
        const wait = this.minimumIntervalMs - (performance.now() - this.lastRequestAt);
        if (wait <= 0) break;
        const remaining = run.deadlineAt ? Math.min(wait, run.deadlineAt - Date.now()) : wait;
        await delay(Math.max(1, Math.ceil(remaining)));
      }
      this.lastRequestAt = performance.now();
    } finally { release(); }
  }
  async read(path, body, run) {
    if (path !== '/shopApi/Shop/goodsList') throw new Error('拒绝非公开读取路径。');
    if (!this.allowedTokens?.has(body.token)) throw new Error('店铺不在本次已选范围内。');
    const checkShop = () => {
      if (!run.isolateUnavailableScopes || !run._unavailableShops?.has(body.token)) return;
      const error = new Error(run._unavailableShops.get(body.token)); error.code = 'SCOPE_UNAVAILABLE'; throw error;
    };
    checkShop();
    await this.acquireRequestSlot(run);
    checkShop();
    const timeoutMs = requestTimeout(run, 20000);
    const startedAt = new Date().toISOString();
    const seq = run.nextRequestSeq = (run.nextRequestSeq || run.requests.length) + 1;
    let result;
    try { const pending = this.page.evaluate(async ({ path, body, visitorId, timeoutMs }) => {
      const since = performance.now();
      const headers = { 'Content-Type': 'application/json' };
      if (visitorId) headers.Visitorid = visitorId;
      const row = {};
      const ledgerKey = Symbol.for('local-price-search.resource-timing');
      const ledger = globalThis[ledgerKey] ||= { calls: [], usedEntries: new Set() };
      const call = { startedAt: null, dispatchedAt: null };
      try {
        // The synchronous fetch invocation gets its own narrow timing window.
        // Parsing/response latency must not extend it into a subsequent call.
        const options = { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin', signal: AbortSignal.timeout(timeoutMs) };
        call.startedAt = performance.now();
        ledger.calls.push(call);
        let pending;
        try { pending = fetch(path, options); }
        finally { call.dispatchedAt = performance.now(); }
        const response = await pending;
        row.httpStatus = response.status;
        row.headers = Object.fromEntries(['etag', 'last-modified', 'cache-control', 'content-encoding', 'date'].filter(k => response.headers.has(k)).map(k => [k, response.headers.get(k)]));
        const raw = await response.text();
        row.decodedBytes = new TextEncoder().encode(raw).length;
        if (!response.ok) row.error = `公开接口返回 HTTP ${response.status}，停止读取，保留旧数据。`;
        else {
          let p; try { p = JSON.parse(raw); } catch { row.error = '公开接口未返回 JSON，停止读取。'; }
          if (p) {
            row.code = ['number', 'string'].includes(typeof p.code) ? p.code : null;
            if (p.code !== 1) {
              const message = p.msg ?? p.message;
              row.businessMessage = typeof message === 'string' ? message.replace(/\s+/g, ' ').trim().slice(0, 200) : null;
              row.error = '公开接口未返回成功状态。';
            }
            else if (Array.isArray(p.data?.list)) {
              const total = p.data.total;
              row.total = typeof total === 'number' || (typeof total === 'string' && /^\d+$/u.test(total))
                ? Number(total) : null;
              row.products = p.data.list.map(x => {
                const toNumber = v => (typeof v === 'number' || typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) && Number.isFinite(Number(v)) ? Number(v) : null;
                const rawStock = toNumber(x.extend?.stock_count ?? x.stock_count);
                let descriptionText = '';
                if (typeof x.description === 'string') {
                  const doc = new DOMParser().parseFromString(x.description, 'text/html');
                  doc.querySelectorAll('script,style,iframe,object').forEach(n => n.remove());
                  descriptionText = (doc.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 12000);
                }
                const rawCategory = Array.isArray(x.category) ? x.category[0] : x.category;
                return {
                  goodsKey: String(x.goods_key || ''), name: String(x.name || ''), descriptionText,
                  imageUrl: typeof x.image === 'string' ? x.image : null,
                  goodsType: typeof x.goods_type === 'string' ? x.goods_type : body.goods_type,
                  // First-party list templates render price with U+FFE5; preserve
                  // the displayed symbol without asserting checkout currency/fees.
                  price: toNumber(x.price), priceSymbol: '￥', stockCount: rawStock !== null && rawStock >= 0 ? rawStock : null,
                  stockState: rawStock === null || rawStock < 0 ? 'unknown' : rawStock === 0 ? 'zero' : 'positive',
                  minQuantity: toNumber(x.extend?.limit_count), createTime: toNumber(x.create_time),
                  updatedTime: x.update_time ?? x.updated_at ?? null,
                  declaredCategoryId: toNumber(rawCategory?.id), declaredCategoryName: typeof rawCategory?.name === 'string' ? rawCategory.name : null,
                  status: ['string', 'number'].includes(typeof x.status) ? x.status : null,
                  listed: true,
                };
              });
            } else row.error = '商品列表结构异常。';
          }
        }
      } catch (error) { row.error = String(error.message).slice(0, 300); }
      // Resource Timing may be queued just after fetch body consumption.
      await new Promise(resolve => setTimeout(resolve, 0));
      // Browsers may stamp the resource fractionally after fetch returns. Allow
      // 2ms, bounded strictly before the next collector fetch. An entry must also
      // match the actual UTF-8 response size; ambiguous/missing data stays null.
      const callIndex = ledger.calls.indexOf(call);
      const nextCall = callIndex >= 0 ? ledger.calls[callIndex + 1] : null;
      const latestStart = call.dispatchedAt === null ? null : call.dispatchedAt + 2;
      const requested = new URL(path, location.origin);
      const entryKey = entry => JSON.stringify([entry.name, entry.startTime, entry.responseEnd, entry.duration,
        entry.encodedBodySize, entry.decodedBodySize, entry.transferSize]);
      const candidates = call.startedAt === null || latestStart === null || !Number.isFinite(row.decodedBytes) ? []
        : performance.getEntriesByType('resource').filter(entry => {
          let url; try { url = new URL(entry.name); } catch { return false; }
          return entry.initiatorType === 'fetch' && url.origin === requested.origin && url.pathname === requested.pathname && url.search === requested.search
            && entry.startTime >= call.startedAt && entry.startTime <= latestStart && (!nextCall || entry.startTime < nextCall.startedAt)
            && entry.decodedBodySize === row.decodedBytes && !ledger.usedEntries.has(entryKey(entry));
        });
      const entry = candidates.length === 1 ? candidates[0] : null;
      if (entry) ledger.usedEntries.add(entryKey(entry));
      // Old calls cannot overlap a future window. Retain enough recent entries
      // for every in-flight read without growing the page bookkeeping forever.
      call.finished = true;
      while (ledger.calls.length > 1000 && ledger.calls[0].finished) ledger.calls.shift();
      if (ledger.usedEntries.size > 20000) for (const used of [...ledger.usedEntries].slice(0, 5000)) ledger.usedEntries.delete(used);
      row.timing = entry ? { encodedBodyBytes: entry.encodedBodySize, transferBytes: entry.transferSize, decodedBodyBytes: entry.decodedBodySize, durationMs: entry.duration } : null;
      row.elapsedMs = performance.now() - since;
      return row;
    }, { path, body, visitorId: this.visitorId, timeoutMs });
      // The gate also accounts for work between granting the slot and dispatch.
      this.lastRequestAt = performance.now();
      result = await pending;
    }
    catch (error) { result = { error: safeError(error), elapsedMs: Date.now() - Date.parse(startedAt) }; }
    const request = { seq, at: startedAt, finishedAt: new Date().toISOString(), path, body, httpStatus: result.httpStatus, code: result.code, businessMessage: result.businessMessage ? safeError(result.businessMessage).slice(0, 200) : undefined, headers: result.headers, timing: result.timing, elapsedMs: result.elapsedMs, decodedBytes: result.decodedBytes, error: result.error, total: result.total, productCount: result.products?.length };
    run.requests.push(request);
    if (result.error) {
      const error = new Error(result.error); error.publicRequest = request;
      if (run.isolateUnavailableScopes && run._unavailableShops instanceof Map && isScopeUnavailableResponse(request)) {
        request.errorCode = 'scope_unavailable';
        run._unavailableShops.set(body.token, request.businessMessage || result.error);
        error.code = 'SCOPE_UNAVAILABLE';
      } else run.stopRequested ||= result.error;
      // Never clear stopRequested: a different concurrent request may already
      // have recorded an access, transport or server failure.
      throw error;
    }
    if (result.products) result.products = result.products.map(p => ({ ...p, imageUrl: normalizeProductImageUrl(p.imageUrl) }));
    return result;
  }
}
