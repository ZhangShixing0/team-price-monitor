'use strict';

const pageSize = 30;
const freshFor = 2 * 60 * 60 * 1000;
const manifestUrl = new URL('./data/manifest.json', location.href);
const byId = id => document.getElementById(id);
const filters = byId('filters');
const query = byId('query');
const stock = byId('stock');
const brand = byId('brand');
const sort = byId('sort');
const rows = byId('rows');
const parameters = new URLSearchParams(location.search);
const brandNames = { chatgpt: 'ChatGPT', codex: 'Codex', unknown: '品牌待核验' };
const shopHosts = new Set(['wzyp.cn', 'ldxp.cn', 'www.ldxp.cn', 'pay.ldxp.cn']);
const imageHosts = new Set(['qn.ldxp.cn', 'www.ldxp.cn', 'wzyp.cn']);
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  hour12: false,
});
let current = null;
let page = 1;
let pages = 1;
let updating = false;
let loadError = '';

query.value = (parameters.get('q') || '').slice(0, 150);
for (const field of [stock, brand, sort]) {
  if ([...field.options].some(option => option.value === parameters.get(field.id))) {
    field.value = parameters.get(field.id);
  }
}

function el(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value != null) element.textContent = String(value);
  return element;
}

function textKey(value) {
  return String(value || '').normalize('NFKC').toLowerCase();
}

function displayTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? dateFormat.format(time) : '待核验';
}

function fresh(value, now) {
  const age = now - Date.parse(value);
  return age >= 0 && age <= freshFor;
}

function observation(product) {
  // An unchanged version can be reconfirmed by a later complete pass.
  const { checkedFrom } = current.manifest;
  return Number.isFinite(Date.parse(checkedFrom)) &&
    !(Date.parse(product.observedAt) >= Date.parse(checkedFrom)) ? checkedFrom : product.observedAt;
}

function safeUrl(value, hosts, pathRule) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password &&
        hosts.has(url.hostname) && (!pathRule || pathRule.test(url.pathname))) {
      return url.href;
    }
  } catch { /* Malformed merchant links are displayed as plain text. */ }
  return null;
}

function compareQuotes(left, right) {
  if (sort.value === 'recent') {
    return (Date.parse(observation(right)) || 0) - (Date.parse(observation(left)) || 0);
  }
  const a = Number.isFinite(left.price);
  const b = Number.isFinite(right.price);
  if (!a || !b) return Number(b) - Number(a);
  return sort.value === 'price_desc' ? right.price - left.price : left.price - right.price;
}

function quoteRow(product, now) {
  const item = el('li', 'quote');
  const thumb = el('span', 'thumb', (product.shopName || '店').slice(0, 1));
  thumb.setAttribute('aria-hidden', 'true');
  const imageUrl = safeUrl(product.imageUrl, imageHosts);
  if (imageUrl) {
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.remove(), { once: true });
    img.src = imageUrl;
    thumb.append(img);
  }
  const details = el('div');
  const title = el('div', 'title');
  const linkUrl = safeUrl(product.itemUrl, shopHosts, /^\/item\/[A-Za-z0-9_.-]+\/?$/);
  if (linkUrl) {
    const link = el('a', null, product.title);
    link.href = linkUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = '查看原店商品';
    title.append(link);
  } else {
    title.textContent = product.title;
  }
  const brandText = Object.hasOwn(brandNames, product.brand) ? brandNames[product.brand] : brandNames.unknown;
  const identity = product.brandInferred && product.brand !== 'unknown' ? brandText + '（推断）' : brandText;
  const metadata = el('div', 'meta');
  const observed = observation(product);
  metadata.append(el('span', null, product.shopName || product.shopToken), el('span', null, identity),
    el('span', null, observed === product.observedAt ? '核验 ' + displayTime(observed) : '已随本轮完整复核'));
  details.append(title, metadata);
  const numbers = el('div', 'numbers');
  const price = Number.isFinite(product.price)
    ? (product.priceSymbol || '') + product.price + (product.priceSymbol ? '' : '（币种待核）')
    : '价格待核';
  let inventory;
  if (!fresh(observed, now)) inventory = '库存待复核';
  else if (product.inStock === true) inventory = Number.isFinite(product.stockCount) ? '库存 ' + product.stockCount : '有货';
  else if (Number.isFinite(product.stockCount) && product.stockCount === 0) inventory = '已缺货';
  else if (product.inStock === false) inventory = '暂不可购';
  else inventory = '库存未知';
  numbers.append(el('span', 'price', price), el('span', 'inventory', inventory));
  item.append(thumb, details, numbers);
  return item;
}

function render() {
  const now = Date.now();
  const notice = byId('notice');
  let message = loadError;
  if (!message && current && !fresh(current.manifest.checkedAt, now)) {
    message = '最近一轮核验已超过两小时。历史价格可在“含缺货与历史报价”中查看。';
  }
  notice.textContent = message;
  notice.hidden = !message;
  const empty = byId('empty');
  if (!current) {
    byId('result-count').textContent = loadError ? '暂无可读取的报价' : '正在读取报价…';
    return;
  }
  const words = textKey(query.value).trim().split(/\s+/).filter(Boolean);
  const matches = current.products.filter(product => {
    if (brand.value && product.brand !== brand.value) return false;
    if (stock.value === 'recent' && !(product.inStock === true && fresh(observation(product), now))) return false;
    const haystack = textKey([product.title, product.shopName, product.brand].join(' '));
    return words.every(word => haystack.includes(word));
  }).sort(compareQuotes);
  const shops = new Set(matches.map(product => product.shopToken));
  byId('result-count').textContent = matches.length + ' 条报价 · ' + shops.size + ' 家店铺';
  const checked = byId('checked-at');
  checked.dateTime = current.manifest.checkedAt;
  checked.textContent = displayTime(current.manifest.checkedAt);
  if (current.manifest.checkedFrom) checked.title = '本轮开始 ' + displayTime(current.manifest.checkedFrom);
  byId('coverage').textContent = '本轮核验 ' + current.manifest.shopCount + ' 家店';
  pages = Math.max(1, Math.ceil(matches.length / pageSize));
  page = Math.min(page, pages);
  rows.replaceChildren(...matches.slice((page - 1) * pageSize, page * pageSize).map(product => quoteRow(product, now)));
  empty.textContent = '没有符合当前筛选的报价。可切换库存范围或清除关键词。';
  empty.hidden = matches.length > 0;
  byId('pages').hidden = pages <= 1;
  byId('previous').disabled = page <= 1;
  byId('next').disabled = page >= pages;
  byId('page-number').textContent = page + ' / ' + pages;
}

async function fetchJson(url, cache) {
  const response = await fetch(url, { cache, credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error('无法读取报价');
  return response.json();
}

async function update() {
  if (updating) return;
  updating = true;
  try {
    const manifest = await fetchJson(manifestUrl, 'no-cache');
    if (manifest.schemaVersion !== 1 || !/^snapshots\/[0-9a-f]{64}\.json$/.test(manifest.snapshot) ||
        !Number.isFinite(Date.parse(manifest.checkedAt)) || !Number.isSafeInteger(manifest.shopCount) ||
        !Number.isSafeInteger(manifest.productCount) || manifest.shopCount < 0 || manifest.productCount < 0) {
      throw new Error('报价索引格式无效');
    }
    let products = current?.products;
    if (!current || manifest.snapshot !== current.manifest.snapshot) {
      const snapshot = await fetchJson(new URL(manifest.snapshot, manifestUrl), 'default');
      products = snapshot.products;
      if (snapshot.schemaVersion !== 1 || !Array.isArray(products) || products.length !== manifest.productCount ||
          !products.every(product => product && typeof product.title === 'string' && typeof product.shopToken === 'string')) {
        throw new Error('报价数据格式无效');
      }
    } else if (products.length !== manifest.productCount) {
      throw new Error('报价数量不一致');
    }
    if (!current && !parameters.has('stock') && !fresh(manifest.checkedAt, Date.now())) stock.value = 'all';
    current = { manifest, products };
    loadError = '';
  } catch {
    loadError = current ? '最新报价文件暂时无法读取，仍显示上次成功取得的版本。' : '报价文件尚未发布或暂时无法读取。';
  } finally {
    updating = false;
    render();
  }
}

function applyFilters() {
  const url = new URL(location.href);
  for (const [key, value, fallback] of [['q', query.value.trim(), ''], ['stock', stock.value, 'recent'],
    ['brand', brand.value, ''], ['sort', sort.value, 'price_asc']]) {
    if (value === fallback) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  history.replaceState(null, '', url);
  page = 1;
  render();
}
filters.addEventListener('submit', event => { event.preventDefault(); applyFilters(); });
query.addEventListener('input', applyFilters);
for (const select of [stock, sort, brand]) select.addEventListener('change', applyFilters);
function movePage(step) {
  page = Math.max(1, Math.min(page + step, pages));
  render();
  byId('quotes').scrollIntoView({ block: 'start' });
}
byId('previous').addEventListener('click', () => movePage(-1));
byId('next').addEventListener('click', () => movePage(1));
document.addEventListener('visibilitychange', () => { if (!document.hidden) update(); });
setInterval(() => { if (!document.hidden) update(); }, 60000);
update();
