export const brands = { chatgpt: 'ChatGPT', codex: 'Codex', unknown: '品牌待核验' };
export const plans = { plus: 'Plus', pro: 'Pro', team: 'Team' };
const compareText = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }).compare;

export function normalizeProducts(products, version) {
  const unique = new Map();
  for (const product of products) {
    const brand = Object.hasOwn(brands, product.brand) ? product.brand : 'unknown';
    const plan = version === 1 ? 'team' : product.plan;
    if (!Object.hasOwn(plans, plan) || !product.shopToken || !product.goodsKey) continue;
    unique.set(JSON.stringify([product.shopToken, product.goodsKey]), {
      ...product, brand, plan, legacy: version === 1,
      comparisonKey: version === 2 && typeof product.comparisonKey === 'string' ? product.comparisonKey || null : null,
      specLabel: version === 2 && typeof product.specLabel === 'string' ? product.specLabel : ''
    });
  }
  return [...unique.values()];
}

export function availablePlans(products, brand, version) {
  if (!brand) return [];
  if (brand === 'chatgpt' && version === 2) return Object.keys(plans);
  return Object.keys(plans).filter(plan => products.some(p => p.brand === brand && p.plan === plan));
}

function stableRowOrder(a, b) {
  return compareText(a.title, b.title) || compareText(a.shopName, b.shopName) ||
    compareText(a.shopToken, b.shopToken) || compareText(a.goodsKey, b.goodsKey);
}

export function hasChange(product, event) {
  if (product.legacy || !Array.isArray(product.changes) || !product.changes.includes(event)) return false;
  if (event === 'restocked') return product.inStock === true;
  if (event === 'price_drop') return product.inStock === true && Number.isFinite(product.previousPrice) &&
    Number.isFinite(product.price) && product.previousPrice > product.price;
  return event === 'first_seen';
}

export function groupQuotes(products, sort, observedTime) {
  const groups = new Map();
  for (const p of products) {
    const currency = String(p.priceSymbol || '').normalize('NFKC');
    const minimum = Number.isSafeInteger(p.minQuantity) && p.minQuantity > 0 ? p.minQuantity : null;
    // Legacy records carry no structured specification. Keep them independent.
    const partial = p.specLabel || '规格待核验';
    const specKey = p.legacy ? [p.shopToken, p.goodsKey] : [partial, p.form || 'unknown'];
    const key = JSON.stringify([p.brand, p.plan, p.comparisonKey || null, specKey, currency, minimum]);
    const notes = [partial];
    if (minimum > 1) notes.push(minimum + ' 件起购');
    if (!currency) notes.push('币种待核');
    else if (!['¥', '元', 'CNY'].includes(currency)) notes.push(currency);
    if (!groups.has(key)) groups.set(key, {
      key, brand: p.brand, plan: p.plan, comparable: Boolean(p.comparisonKey),
      label: notes.join(' · '), products: []
    });
    groups.get(key).products.push(p);
  }
  const sorted = [...groups.values()].sort((a, b) =>
    compareText(brands[a.brand], brands[b.brand]) ||
    Object.keys(plans).indexOf(a.plan) - Object.keys(plans).indexOf(b.plan) ||
    Number(b.comparable) - Number(a.comparable) || compareText(a.label, b.label) || compareText(a.key, b.key));
  for (const g of sorted) {
    g.products.sort((a, b) => {
      if (sort === 'recent') return (Date.parse(observedTime(b)) || 0) - (Date.parse(observedTime(a)) || 0) || stableRowOrder(a, b);
      if (Number.isFinite(a.price) !== Number.isFinite(b.price)) return Number.isFinite(a.price) ? -1 : 1;
      if (Number.isFinite(a.price) && a.price !== b.price) return sort === 'price_desc' ? b.price - a.price : a.price - b.price;
      return stableRowOrder(a, b);
    });
  }
  return sorted;
}

export function groupsOnPage(groups, start, pageSize) {
  const page = [];
  let offset = 0;
  for (const group of groups) {
    const end = offset + group.products.length;
    if (end > start && offset < start + pageSize) {
      page.push({ ...group, total: group.products.length,
        products: group.products.slice(Math.max(0, start - offset), start + pageSize - offset) });
    }
    offset = end;
  }
  return page;
}
