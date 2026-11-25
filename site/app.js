import { brands, plans, normalizeProducts, availablePlans, groupQuotes, groupsOnPage } from './catalog-view.mjs';

const pageSize = 30;
const freshFor = 2 * 60 * 60 * 1000;
const manifestUrl = new URL('./data/manifest.json', location.href);
const embeddedDemo = document.getElementById('demo-data');
const byId = id => document.getElementById(id);
const filters = byId('filters');
const query = byId('query');
const stock = byId('stock');
const brand = byId('brand');
const sort = byId('sort');
const rows = byId('rows');
const parameters = new URLSearchParams(location.search);
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
let selectedPlan = parameters.get('plan') || '';
let planFilterKey = '';

query.value = (parameters.get('q') || '').slice(0, 150);
for (const field of [stock, sort]) {
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

function setBrandOptions(products, desired) {
  const options = Object.keys(brands).filter(key => products.some(p => p.brand === key));
  const initial = options.includes('chatgpt') ? 'chatgpt' : '';
  const makeOption = (value, text) => new Option(text, value);
  brand.replaceChildren(...options.map(key => makeOption(key, brands[key])), makeOption('', '全部品牌'));
  brand.value = desired === '' || desired === 'all' ? '' : options.includes(desired) ? desired : initial;
}

function setPlanOptions(available, brandMatches) {
  if (!available.includes(selectedPlan)) selectedPlan = '';
  const counts = new Map();
  for (const p of brandMatches) counts.set(p.plan, (counts.get(p.plan) || 0) + 1);
  const key = JSON.stringify([brand.value, available, [...counts.entries()], selectedPlan]);
  if (key === planFilterKey) return;
  planFilterKey = key;
  const container = byId('plans');
  const oldFocus = container.contains(document.activeElement) ? document.activeElement.dataset.plan : null;
  if (!brand.value) {
    container.replaceChildren(el('span', 'filter-hint', '选择品牌后可筛套餐'));
    return;
  }
  const buttons = ['', ...available].map(plan => {
    const b = el('button', 'plan-option', plan ? plans[plan] : '全部套餐');
    b.type = 'button';
    b.dataset.plan = plan;
    b.setAttribute('aria-pressed', String(selectedPlan === plan));
    b.append(el('span', 'option-count', plan ? counts.get(plan) || 0 : brandMatches.length));
    b.addEventListener('click', () => { selectedPlan = plan; applyFilters(); });
    return b;
  });
  container.replaceChildren(...buttons);
  if (oldFocus !== null) buttons.find(b => b.dataset.plan === oldFocus)?.focus();
}

function quoteRow(product, now) {
  const item = el('li', 'quote');
  const imageUrl = safeUrl(product.imageUrl, imageHosts);
  if (imageUrl) {
    const img = el('img', 'thumb');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      img.remove();
      item.classList.remove('with-thumb');
    }, { once: true });
    item.classList.add('with-thumb');
    item.append(img);
    img.src = imageUrl;
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
  const brandText = brands[product.brand] || brands.unknown;
  const evidence = { description: '商品说明', category: '原店分类' }[product.brandEvidence] || '推断';
  const identity = product.brandInferred && product.brand !== 'unknown' ? brandText + '（' + evidence + '）' : brandText;
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
  if (current.manifest.source === 'demo') {
    inventory = product.inStock ? '示例有货' : '示例缺货';
  } else if (current.manifest.source === 'archive') {
    if (product.inStock === true) inventory = '采集时有货';
    else if (product.stockCount === 0) inventory = '采集时缺货';
    else if (product.inStock === false) inventory = '采集时不可购';
    else inventory = '库存待复核';
  } else if (!fresh(observed, now)) inventory = '库存待复核';
  else if (product.inStock === true) inventory = Number.isFinite(product.stockCount) ? '库存 ' + product.stockCount : '有货';
  else if (Number.isFinite(product.stockCount) && product.stockCount === 0) inventory = '已缺货';
  else if (product.inStock === false) inventory = '暂不可购';
  else inventory = '库存未知';
  numbers.append(el('span', 'price', price), el('span', 'inventory', inventory));
  item.append(details, numbers);
  return item;
}

function renderGroup(group, now) {
  const section = el('div', 'quote-group');
  const header = el('div', 'group-header');
  header.append(el('h3', null, brands[group.brand] + ' ' + plans[group.plan] + ' · ' + group.label),
    el('span', null, (group.comparable ? '同规格比价' : '规格待核，仅列原店标价') + ' · ' + group.total + ' 条'));
  const list = el('ul');
  list.append(...group.products.map(product => quoteRow(product, now)));
  section.append(header, list);
  return section;
}

function render() {
  const now = Date.now();
  const notice = byId('notice');
  let message = loadError;
  if (!message && current?.manifest.source === 'demo') {
    message = '演示模式。商品、价格和库存均为虚构，可试用筛选和排序。';
  } else if (!message && current?.manifest.source === 'archive') {
    message = '以下为历史采集时的原店标价，库存待复核。';
  } else if (!message && current && !fresh(current.manifest.checkedAt, now)) {
    message = '以下为上次核验的原店标价，库存待复核。';
  }
  if (current?.manifest.schemaVersion === 1) {
    message = [message, '旧版快照仅含 Team，品牌归属和规格待复核。'].filter(Boolean).join(' ');
  }
  notice.textContent = message;
  notice.hidden = !message;
  const empty = byId('empty');
  if (!current) {
    byId('result-count').textContent = loadError ? '暂无可读取的报价' : '正在读取报价…';
    return;
  }
  const words = textKey(query.value).trim().split(/\s+/).filter(Boolean);
  const pool = current.products.filter(product => {
    if (stock.value === 'recent' && (current.manifest.source === 'archive' || product.inStock !== true ||
      (current.manifest.source !== 'demo' && !fresh(observation(product), now)))) return false;
    const haystack = textKey([product.title, product.shopName, brands[product.brand], plans[product.plan], product.specLabel].join(' '));
    return words.every(word => haystack.includes(word));
  });
  const brandMatches = pool.filter(p => !brand.value || p.brand === brand.value);
  setPlanOptions(availablePlans(current.products, brand.value, current.manifest.schemaVersion), brandMatches);
  const matches = brandMatches.filter(p => !selectedPlan || p.plan === selectedPlan);
  const groups = groupQuotes(matches, sort.value, observation);
  const shops = new Set(matches.map(product => product.shopToken));
  byId('result-count').textContent = matches.length + ' 件商品 · ' + shops.size + ' 家店铺';
  const other = byId('other-team');
  const pending = brand.value === 'chatgpt' && selectedPlan === 'team' ? pool.filter(p => p.brand === 'unknown' && p.plan === 'team').length : 0;
  other.hidden = pending === 0;
  if (pending) other.textContent = '另有 ' + pending + ' 条 Team 品牌待核 →';
  const checked = byId('checked-at');
  checked.dateTime = current.manifest.checkedAt;
  checked.textContent = displayTime(current.manifest.checkedAt);
  if (current.manifest.checkedFrom) checked.title = '本轮开始 ' + displayTime(current.manifest.checkedFrom);
  byId('coverage').textContent = '采集范围 ' + current.manifest.shopCount + ' 家店';
  pages = Math.max(1, Math.ceil(matches.length / pageSize));
  page = Math.min(page, pages);
  rows.replaceChildren(...groupsOnPage(groups, (page - 1) * pageSize, pageSize).map(g => renderGroup(g, now)));
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
    const demo = embeddedDemo ? JSON.parse(embeddedDemo.textContent) : null;
    const manifest = embeddedDemo ? demo.manifest : await fetchJson(manifestUrl, 'no-cache');
    if (![1, 2].includes(manifest.schemaVersion) || !/^snapshots\/[0-9a-f]{64}\.json$/.test(manifest.snapshot) ||
        !Number.isFinite(Date.parse(manifest.checkedAt)) || !Number.isSafeInteger(manifest.shopCount) ||
        !Number.isSafeInteger(manifest.productCount) || manifest.shopCount < 0 || manifest.productCount < 0) {
      throw new Error('报价索引格式无效');
    }
    let products = current?.products;
    if (!current || manifest.snapshot !== current.manifest.snapshot) {
      const snapshot = embeddedDemo ? demo.snapshot : await fetchJson(new URL(manifest.snapshot, manifestUrl), 'default');
      products = snapshot.products;
      if (snapshot.schemaVersion !== manifest.schemaVersion || !Array.isArray(products) || products.length !== manifest.productCount ||
          !products.every(product => product && typeof product.title === 'string' && typeof product.shopToken === 'string')) {
        throw new Error('报价数据格式无效');
      }
      products = normalizeProducts(products, snapshot.schemaVersion);
      const wantedBrand = current ? brand.value : parameters.has('brand') ? parameters.get('brand') : null;
      setBrandOptions(products, wantedBrand);
    } else if (current.manifest.productCount !== manifest.productCount) {
      throw new Error('报价数量不一致');
    }
    if (!current && !parameters.has('stock') && (['demo', 'archive'].includes(manifest.source) || !fresh(manifest.checkedAt, Date.now()))) stock.value = 'all';
    if (manifest.source === 'demo') stock.options[0].textContent = '示例有货';
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
  const available = current ? availablePlans(current.products, brand.value, current.manifest.schemaVersion) : [];
  if (!available.includes(selectedPlan)) selectedPlan = '';
  const url = new URL(location.href);
  for (const [key, value, fallback] of [['q', query.value.trim(), ''], ['stock', stock.value, 'recent'],
    ['brand', brand.value || 'all', 'chatgpt'], ['plan', selectedPlan, ''], ['sort', sort.value, 'price_asc']]) {
    if (value === fallback) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  if (!embeddedDemo) history.replaceState(null, '', url);
  page = 1;
  render();
}
filters.addEventListener('submit', event => { event.preventDefault(); applyFilters(); });
query.addEventListener('input', applyFilters);
for (const select of [stock, sort]) select.addEventListener('change', applyFilters);
brand.addEventListener('change', () => { selectedPlan = ''; applyFilters(); });
byId('other-team').addEventListener('click', () => {
  brand.value = 'unknown'; selectedPlan = 'team'; applyFilters();
  byId('result-count').scrollIntoView({ block: 'nearest' });
});
function movePage(step) {
  page = Math.max(1, Math.min(page + step, pages));
  render();
  byId('quotes').scrollIntoView({ block: 'start' });
}
byId('previous').addEventListener('click', () => movePage(-1));
byId('next').addEventListener('click', () => movePage(1));
if (!embeddedDemo) {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) update(); });
  setInterval(() => { if (!document.hidden) update(); }, 60000);
}
update();
