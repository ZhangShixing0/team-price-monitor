import { brands, plans, normalizeProducts, availablePlans, groupQuotes, groupsOnPage, hasChange } from './catalog-view.mjs';

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
const change = byId('change');
const advanced = byId('more-filters');
const rows = byId('rows');
const changeNames = { restocked: '本轮补货', price_drop: '同规格降价', first_seen: '首次发现' };
const shopHosts = new Set(['wzyp.cn', 'ldxp.cn', 'www.ldxp.cn', 'pay.ldxp.cn']);
const imageHosts = new Set(['qn.ldxp.cn', 'www.ldxp.cn', 'wzyp.cn']);
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  hour12: false, timeZone: 'Asia/Shanghai',
});
let current = null;
let page = 1;
let pages = 1;
let updating = false;
let loadError = '';
let selectedPlan = '';
let planFilterKey = '';
let explicitStock = false;

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

function defaultStock(manifest) {
  return manifest && (['demo', 'archive'].includes(manifest.source) || !fresh(manifest.checkedAt, Date.now())) ? 'all' : 'recent';
}

function restoreFilters() {
  const parameters = new URLSearchParams(location.search);
  selectedPlan = parameters.get('plan') || '';
  query.value = (parameters.get('q') || '').slice(0, 150);
  explicitStock = [...stock.options].some(option => option.value === parameters.get('stock'));
  for (const [field, fallback] of [[stock, defaultStock(current?.manifest)], [sort, 'price_asc'], [change, '']]) {
    const value = parameters.get(field.id);
    field.value = [...field.options].some(option => option.value === value) ? value : fallback;
  }
  if (current) setBrandOptions(current.products, parameters.get('brand'));
  byId('share-result').hidden = true;
  page = 1;
}

function filterUrl() {
  const url = new URL(location.href);
  const wantedBrand = brand.value === 'chatgpt' && !selectedPlan ? '' : brand.value || 'all';
  for (const [key, value] of [['brand', wantedBrand], ['plan', selectedPlan], ['q', query.value.trim()],
    ['stock', explicitStock ? stock.value : ''], ['sort', sort.value === 'price_asc' ? '' : sort.value], ['change', change.value]]) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  return url;
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

function setPlanOptions(available) {
  if (!available.includes(selectedPlan)) selectedPlan = '';
  const key = JSON.stringify([brand.value, available, selectedPlan]);
  if (key === planFilterKey) return;
  planFilterKey = key;
  const container = byId('plans');
  const oldFocus = container.contains(document.activeElement) ? document.activeElement.dataset.plan : null;
  if (!brand.value) {
    container.replaceChildren(el('span', 'filter-hint', '选择品牌后可筛套餐'));
    return;
  }
  const buttons = ['', ...available].map(plan => {
    const b = el('button', 'plan-option', plan ? plans[plan] : '全部');
    b.type = 'button';
    b.dataset.plan = plan;
    b.setAttribute('aria-pressed', String(selectedPlan === plan));
    b.addEventListener('click', () => { selectedPlan = plan; applyFilters(); });
    return b;
  });
  container.replaceChildren(...buttons);
  if (oldFocus !== null) buttons.find(b => b.dataset.plan === oldFocus)?.focus();
}

function quoteRow(product, group, now, openDetails) {
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
  const body = el('div', 'quote-body');
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
  const observed = observation(product);
  const details = el('details', 'quote-details');
  details.dataset.quoteId = JSON.stringify([product.shopToken, product.goodsKey]);
  details.open = openDetails.has(details.dataset.quoteId);
  const summary = el('summary', 'quote-summary meta');
  summary.append(el('span', 'shop-name', product.shopName || product.shopToken));
  if (product.minQuantity > 1) summary.append(el('span', 'minimum', product.minQuantity + ' 件起购'));
  summary.append(el('span', 'details-trigger', '详情'));
  const facts = el('dl', 'quote-facts');
  const fact = (label, value) => facts.append(el('dt', null, label), el('dd', null, value));
  fact('商品规格', group.label);
  if (!group.comparable) fact('比价条件', '部分规格仍待核对，价格为原店标价');
  const evidence = { title: '商品标题', description: '商品说明', category: '原店分类' }[product.brandEvidence];
  fact('所属套餐', brandText + ' ' + plans[product.plan] + (evidence ? '（依据' + evidence + '）' : ''));
  fact('核验时间', displayTime(observed) + '（北京时间）');
  if (Number.isSafeInteger(product.stockCount) && product.stockCount >= 0) fact('核验时库存', product.stockCount + ' 件');
  for (const [event, label] of Object.entries(changeNames)) {
    if (!hasChange(product, event)) continue;
    fact('本轮变化', event === 'price_drop' ? label + ' · 原价 ' + (product.priceSymbol || '') + product.previousPrice : label);
  }
  details.append(summary, facts);
  if (linkUrl) {
    const viewItem = el('a', 'original-item', '查看原店商品 ↗');
    viewItem.href = linkUrl;
    viewItem.target = '_blank';
    viewItem.rel = 'noopener noreferrer';
    details.append(viewItem);
  }
  body.append(title, details);
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
  const status = el('span', 'inventory', inventory);
  const inventoryRecorded = ['archive', 'demo'].includes(current.manifest.source) || fresh(observed, now);
  if (inventoryRecorded && typeof product.inStock === 'boolean') status.classList.add(product.inStock ? 'stock-yes' : 'stock-no');
  numbers.append(el('span', 'price', price), status);
  item.append(body, numbers);
  return item;
}

function renderQuoteGroups(groups, now) {
  const result = document.createDocumentFragment();
  const openDetails = new Set([...rows.querySelectorAll('.quote-details[open]')].map(d => d.dataset.quoteId));
  let previous, list;
  for (const group of groups) {
    const newPlan = previous?.brand !== group.brand || previous?.plan !== group.plan;
    const planName = brands[group.brand] + ' ' + plans[group.plan];
    if (newPlan || group.comparable || previous.comparable) {
      const section = el('div', 'quote-group');
      list = el('ul');
      list.setAttribute('aria-label', planName + '报价');
      if (group.comparable && group.total > 1) {
        const header = el('div', 'group-header');
        const label = selectedPlan && brand.value ? group.label : planName + ' · ' + group.label;
        header.append(el('h3', null, label), el('span', null, '同规格 · ' + group.total + ' 条'));
        section.append(header);
      } else if (newPlan && (!selectedPlan || !brand.value)) {
        const header = el('div', 'group-header plan-heading');
        header.append(el('h3', null, planName));
        section.append(header);
      }
      section.append(list);
      result.append(section);
    }
    // Keep the original price order inside each spec group. Only the visual
    // listing is continuous when the underlying offers cannot be compared.
    list.append(...group.products.map(product => quoteRow(product, group, now, openDetails)));
    previous = group;
  }
  return result;
}

function render() {
  const now = Date.now();
  const notice = byId('notice');
  let message = loadError;
  if (!message && current?.manifest.source === 'demo') {
    message = '离线演示 · 虚构报价';
  } else if (!message && current?.manifest.source === 'archive') {
    message = '历史报价';
  } else if (!message && current && !fresh(current.manifest.checkedAt, now)) {
    message = '库存待复核';
  }
  if (current?.manifest.schemaVersion === 1) {
    message = [message, '旧版快照仅含 Team，品牌归属和规格待复核。'].filter(Boolean).join(' ');
  }
  notice.textContent = message;
  notice.hidden = !message;
  notice.classList.toggle('notice-error', Boolean(loadError));
  const empty = byId('empty');
  if (!current) {
    byId('result-count').textContent = loadError ? '暂无可读取的报价' : '正在读取报价…';
    return;
  }
  const words = textKey(query.value).trim().split(/\s+/).filter(Boolean);
  const pool = current.products.filter(product => {
    if (change.value && !hasChange(product, change.value)) return false;
    if (stock.value === 'observed' && product.inStock !== true) return false;
    if (stock.value === 'recent' && (current.manifest.source === 'archive' || product.inStock !== true ||
      (current.manifest.source !== 'demo' && !fresh(observation(product), now)))) return false;
    const haystack = textKey([product.title, product.shopName, brands[product.brand], plans[product.plan], product.specLabel].join(' '));
    return words.every(word => haystack.includes(word));
  });
  const brandMatches = pool.filter(p => !brand.value || p.brand === brand.value);
  setPlanOptions(availablePlans(current.products, brand.value, current.manifest.schemaVersion));
  const matches = brandMatches.filter(p => !selectedPlan || p.plan === selectedPlan);
  const groups = groupQuotes(matches, sort.value, observation);
  const shops = new Set(matches.map(product => product.shopToken));
  byId('results-title').textContent = selectedPlan ? plans[selectedPlan] + ' 报价' : '全部报价';
  byId('result-count').textContent = matches.length + ' 件商品 · ' + shops.size + ' 家店铺';
  const advancedCount = Number(stock.value !== defaultStock(current.manifest)) + Number(Boolean(change.value));
  const badge = byId('filter-count');
  badge.hidden = advancedCount === 0;
  badge.textContent = advancedCount ? String(advancedCount) : '';
  advanced.querySelector('summary').setAttribute('aria-label',
    advancedCount ? '筛选，已设置 ' + advancedCount + ' 项' : '筛选库存和本轮变化');
  byId('reset-advanced').hidden = advancedCount === 0;
  const other = byId('other-team');
  const pending = brand.value === 'chatgpt' && selectedPlan === 'team' ? pool.filter(p => p.brand === 'unknown' && p.plan === 'team').length : 0;
  other.hidden = pending === 0;
  if (pending) other.textContent = '另有 ' + pending + ' 条 Team 品牌待核 →';
  const checked = byId('checked-at');
  checked.dateTime = current.manifest.checkedAt;
  checked.textContent = displayTime(current.manifest.checkedAt);
  checked.parentElement.hidden = false;
  if (current.manifest.checkedFrom) checked.title = '本轮开始 ' + displayTime(current.manifest.checkedFrom);
  byId('coverage').textContent = '本轮采集范围 · ' + current.manifest.shopCount + ' 家店';
  pages = Math.max(1, Math.ceil(matches.length / pageSize));
  page = Math.min(page, pages);
  rows.replaceChildren(renderQuoteGroups(groupsOnPage(groups, (page - 1) * pageSize, pageSize), now));
  if (change.value) empty.textContent = '符合当前筛选的报价里，没有已核实的「' + changeNames[change.value] + '」记录。';
  else if (stock.value === 'recent' && current.manifest.source === 'archive') empty.textContent = '这份归档只记录当时的库存。可选择「核验时有货」查看当时可买的商品。';
  else empty.textContent = '没有符合当前筛选的报价。可切换库存范围或清除关键词。';
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
      const wantedBrand = current ? brand.value : new URLSearchParams(location.search).get('brand');
      setBrandOptions(products, wantedBrand);
    } else if (current.manifest.productCount !== manifest.productCount) {
      throw new Error('报价数量不一致');
    }
    if (!explicitStock && (!current || current.manifest.source !== manifest.source)) stock.value = defaultStock(manifest);
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

function applyFilters(replace = false) {
  if (!current) return;
  const available = availablePlans(current.products, brand.value, current.manifest.schemaVersion);
  if (!available.includes(selectedPlan)) selectedPlan = '';
  if (!embeddedDemo) {
    const url = filterUrl();
    if (url.href !== location.href) history[replace ? 'replaceState' : 'pushState'](null, '', url);
  }
  byId('share-result').hidden = true;
  page = 1;
  render();
}
filters.addEventListener('submit', event => { event.preventDefault(); applyFilters(); });
query.addEventListener('input', () => applyFilters(true));
for (const select of [stock, sort, change]) select.addEventListener('change', () => {
  if (select === stock) explicitStock = true;
  applyFilters();
});
brand.addEventListener('change', () => { selectedPlan = ''; applyFilters(); });
byId('reset-advanced').addEventListener('click', () => {
  explicitStock = false;
  stock.value = defaultStock(current?.manifest);
  change.value = '';
  applyFilters();
  advanced.open = false;
  advanced.querySelector('summary').focus();
});
advanced.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    advanced.open = false;
    advanced.querySelector('summary').focus();
  }
});
document.addEventListener('click', event => {
  if (advanced.open && !advanced.contains(event.target)) advanced.open = false;
});
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
  byId('copy-link').hidden = false;
  byId('copy-link').addEventListener('click', async () => {
    const url = filterUrl().href;
    const field = byId('share-url');
    field.hidden = true;
    byId('share-result').hidden = false;
    try {
      await navigator.clipboard.writeText(url);
      byId('share-status').textContent = '链接已复制，打开后会保留当前筛选。';
    } catch {
      byId('share-status').textContent = '可手动复制下方网址，或在浏览器菜单中收藏当前页面。';
      field.value = url;
      field.hidden = false;
      field.focus();
      field.select();
    }
  });
  window.addEventListener('popstate', () => { restoreFilters(); render(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) update(); });
  setInterval(() => { if (!document.hidden) update(); }, 60000);
}
restoreFilters();
update();
