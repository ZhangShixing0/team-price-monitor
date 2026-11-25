import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { classifyProduct } from './classifier.mjs';
import { PublicListReader } from './public-list.mjs';
import { collectScopes } from './scoped-collector.mjs';
import { observeEntryErrors, waitForCategory } from './entry-status.mjs';

const origin = 'https://wzyp.cn';
const validToken = /^[A-Za-z0-9_.-]{1,100}$/u;
const types = new Set(['card', 'article', 'resource', 'equity']);

export async function readPilotConfig() {
  const config = JSON.parse(await readFile(new URL('../config/pilot.json', import.meta.url), 'utf8'));
  // shopSlug is the visible final segment of a public /shop/<slug> URL.
  // Only the collector's internal data model uses the source naming.
  config.shops = config.shops.map(({ shopSlug, shopName }) => ({ shop_token: shopSlug, shopName }));
  config.scopes = config.scopes.map(({ shopSlug, ...scope }) => ({ ...scope, shopToken: shopSlug }));
  const names = new Map(config.shops.map(shop => [shop.shop_token, shop.shopName]));
  if (names.size !== 20 || config.shops.length !== names.size ||
      config.shops.some(shop => typeof shop.shop_token !== 'string' || !validToken.test(shop.shop_token) || typeof shop.shopName !== 'string')) {
    throw new Error('20 店试运行配置需要 20 个不同的公开店铺编号。');
  }
  const scopeIds = new Set();
  const scopedShops = new Set();
  for (const scope of config.scopes) {
    const id = JSON.stringify([scope.shopToken, scope.goodsType, scope.categoryId]);
    if (!names.has(scope.shopToken) || !types.has(scope.goodsType) ||
        !Number.isSafeInteger(scope.categoryId) || scope.categoryId < 1 ||
        !scope.categoryName || scopeIds.has(id)) {
      throw new Error('店铺分类配置无效或重复。');
    }
    scope.shopName = names.get(scope.shopToken);
    scopedShops.add(scope.shopToken);
    scopeIds.add(id);
  }
  if (scopedShops.size !== names.size ||
      !Number.isInteger(config.minimumIntervalMs) || config.minimumIntervalMs < 225 ||
      !Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 3 ||
      !Number.isInteger(config.budgetMs) || config.budgetMs <= 0) {
    throw new Error('分类覆盖或采集间隔配置无效。');
  }
  return config;
}

export function isPublicTeamOffer(product) {
  const c = product.classification || classifyProduct(product);
  const evidence = c.teamEvidence;
  const brand = c.inferredBrand || c.brand;
  if (!c.teamCandidate || evidence?.exclusionCode || evidence?.exclusionReason ||
      evidence?.competingBrand || !['chatgpt', 'codex', 'unknown'].includes(brand)) return false;
  const title = (product.name || '').normalize('NFKC').toLowerCase();
  const category = product.declaredCategoryName || product.categoryName || '';
  if (/(?:优惠码|折扣码|折扣券|优惠券)/u.test(title) &&
      (/(?:优惠码|折扣码|折扣券|优惠券)/u.test(category) ||
       /(?:team|business)\s*(?:\d+(?:\.\d+)?折\s*)?(?:优惠码|折扣码|优惠券|折扣券)/u.test(title))) return false;
  // A mixed merchant category cannot identify the product being sold.
  if (evidence?.title === true) return true;
  const declared = (product.descriptionText || '').normalize('NFKC');
  return /(?:【商品内容】|(?:本商品|商品内容|交付内容|交付商品|所售商品)\s*(?:为|是|[:：]))\s*(?:ChatGPT|Codex)\s*(?:Team\b|Business\b|团队)/iu.test(declared) &&
    !/即梦|dreamina|g[\s.]*plus|(?:codex|gpt)\s*pro\b/iu.test(title);
}

class PilotCollector extends PublicListReader {
  constructor(config) {
    super();
    this.allowedTokens = new Set(config.shops.map(s => s.shop_token));
    this.minimumIntervalMs = config.minimumIntervalMs;
    this.lastRequestAt = -Infinity;
    this.requestGate = Promise.resolve();
    this.sessionBytes = null;
    this.finishedRequests = 0;
    this.failedRequests = 0;
  }

  async init(onProgress, { signal, deadlineAt }) {
    const remaining = max => {
      signal?.throwIfAborted();
      const left = deadlineAt - Date.now();
      if (left <= 0) throw new Error('本轮读取达到时间预算。');
      return Math.min(max, left);
    };
    const channel = process.env.PILOT_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
    if (!['msedge', 'chromium'].includes(channel)) throw new Error('PILOT_BROWSER 仅支持 msedge 或 chromium。');
    const headless = process.env.PILOT_HEADLESS;
    if (headless !== undefined && !['0', '1'].includes(headless)) throw new Error('PILOT_HEADLESS 应为 0 或 1。');
    const headlessMode = headless === undefined ? process.platform !== 'win32' : headless === '1';
    onProgress({ phase: 'connecting', message: '正在打开公开店铺。' });
    try {
      this.browser = await chromium.launch({
        ...(channel === 'msedge' ? { channel } : {}),
        headless: headlessMode,
        args: !headlessMode && process.platform === 'win32' ? ['--start-minimized'] : [],
        timeout: remaining(30000)
      });
    } catch (error) {
      if (error?.name === 'TimeoutError') throw new Error('启动浏览器超时。');
      throw new Error('无法启动专用浏览器，请检查选定的浏览器、运行权限及图形显示环境。');
    }
    const context = await this.browser.newContext();
    this.page = await context.newPage();
    const meter = await context.newCDPSession(this.page);
    await meter.send('Network.enable');
    this.sessionBytes = 0;
    meter.on('Network.loadingFinished', event => {
      this.finishedRequests++;
      this.sessionBytes += event.encodedDataLength;
    });
    meter.on('Network.loadingFailed', () => { this.failedRequests++; });
    meter.on('Network.requestWillBeSent', event => {
      if (event.redirectResponse?.encodedDataLength > 0) this.sessionBytes += event.redirectResponse.encodedDataLength;
    });
    let response;
    const observations = observeEntryErrors(this.page);
    try {
      const ready = this.page.waitForResponse(result => {
        const url = new URL(result.url());
        return url.origin === origin && url.pathname === '/shopApi/Shop/categoryList';
      }, { timeout: remaining(30000) });
      ready.catch(() => {});
      const firstToken = this.allowedTokens.values().next().value;
      const nav = await this.page.goto(`${origin}/shop/${firstToken}`, {
        waitUntil: 'domcontentloaded', timeout: remaining(30000)
      });
      if (nav?.status() !== 200 || new URL(this.page.url()).origin !== origin) {
        throw new Error(`公开店铺入口响应异常（HTTP ${nav?.status() || '未知'}）。`);
      }
      response = await waitForCategory(this.page, ready, observations);
    } finally {
      observations.stop();
    }
    if (!response.ok()) throw new Error(`公开分类返回 HTTP ${response.status()}。`);
    if ((await response.json())?.code !== 1) throw new Error('公开分类未返回成功状态。');
    this.visitorId = await response.request().headerValue('visitorid');
    await this.page.evaluate(() => performance.setResourceTimingBufferSize(15000));
  }
}

export async function collectPilot({ config, onProgress = () => {}, signal } = {}) {
  config ??= await readPilotConfig();
  const collector = new PilotCollector(config);
  try {
    const run = await collectScopes(collector, {
      scopes: config.scopes, query: 'team', pageSize: 100, concurrency: config.concurrency,
      budgetMs: config.budgetMs, onProgress, signal
    });
    // This separate meter includes completed page/bootstrap transfers, even when
    // access is denied before any product requests. It excludes TCP/TLS headers.
    run.stats.browserResponseBytes = collector.sessionBytes;
    run.stats.browserFinishedRequests = collector.finishedRequests;
    run.stats.browserFailedRequests = collector.failedRequests;
    return run;
  } finally {
    await collector.browser?.close();
  }
}
