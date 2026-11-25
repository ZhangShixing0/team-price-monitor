export const brands = { chatgpt: 'ChatGPT', codex: 'Codex', unknown: '品牌待核验' };
export const plans = { plus: 'Plus', pro: 'Pro', team: 'Team' };
const compareText = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }).compare;

export function titleDuration(title) {
  const result = [];
  const chinese = { 一个: 1, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const units = { 小时: 'hour', 天: 'day', 日: 'day', 月: 'month', 年: 'year', hours: 'hour', hour: 'hour', h: 'hour', days: 'day', day: 'day', months: 'month', month: 'month', years: 'year', year: 'year' };
  const pattern = /(?<amount>\d+|一个|两|二|一|三|四|五|六|七|八|九|十)\s*(?:个\s*)?(?<unit>小时|天|日|月|年|hours?\b|days?\b|months?\b|years?\b|h\b)/gu;
  for (const match of title.matchAll(pattern)) {
    const before = title.slice(Math.max(0, match.index - 14), match.index);
    const clause = before.split(/[】\]）)｜|,，;；]/u).at(-1);
    const after = title.slice(match.index + match[0].length, match.index + match[0].length + 12);
    const unit = match.groups.unit;
    const calendarDate = unit === '年' && /^\s*\d{1,2}月/u.test(after)
      || unit === '月' && /^\s*\d{1,2}[日号]/u.test(after)
      || unit === '日' && (/\d{1,2}\s*月\s*$/u.test(before)
        || /^\s*(?:上午|下午|中午|凌晨|早上|晚上|晚|早)?\s*(?:\d{1,2}\s*[:：点时]|开踢|移除|到期)/u.test(after));
    const hourWindow = units[unit] === 'hour'
      && /(?:周限额?|限额|额度|用量|配额|窗口)\s*(?:和|及|与|带|为|每|、|\/)?\s*有?\s*$/u.test(clause);
    let role = 'duration';
    if (calendarDate) role = 'calendar_date';
    else if (/\d\s*[-~～至到]\s*$/u.test(before)) role = 'range_ambiguous';
    else if (/质保|保修|保退|保障|warranty/u.test(clause) || /^(?:全面|全程)?(?:保修|质保|warranty)/u.test(after)) role = 'warranty';
    else if (hourWindow || /^\s*(?:限制|限额|额度|窗口)/u.test(after)) role = 'usage_window';
    else if (/^(?:优惠|折扣|资格)/u.test(after)) role = 'promotion';
    result.push({ value: Number(match.groups.amount) || chinese[match.groups.amount], unit: units[match.groups.unit], text: match[0], source: 'title', role });
  }
  if (/月权益|月卡/u.test(title) && !result.some(claim => claim.role === 'duration')) result.push({ value: 1, unit: 'month', text: title.includes('月权益') ? '月权益' : '月卡', source: 'title', role: 'duration' });
  const candidates = result.filter(claim => claim.role === 'duration');
  const unique = new Map(candidates.map(claim => [`${claim.value}:${claim.unit}`, claim]));
  const ambiguous = result.some(claim => claim.role === 'range_ambiguous') || unique.size > 1;
  const selected = !ambiguous && unique.size === 1 ? [...unique.values()][0] : null;
  return { duration: selected ? { value: selected.value, unit: selected.unit, text: selected.text, source: 'title' } : null, claims: result, ambiguous };
}

export function normalizeProducts(products, version) {
  const unique = new Map();
  for (const product of products) {
    const brand = Object.hasOwn(brands, product.brand) ? product.brand : 'unknown';
    const plan = version === 1 ? 'team' : product.plan;
    if (!Object.hasOwn(plans, plan) || !product.shopToken || !product.goodsKey) continue;
    const storedLabel = version === 2 && typeof product.specLabel === 'string' ? product.specLabel : '';
    const specLabel = reviewStoredTerm(product.title, storedLabel);
    const corrected = specLabel !== storedLabel;
    unique.set(JSON.stringify([product.shopToken, product.goodsKey]), {
      ...product, brand, plan, legacy: version === 1,
      comparisonKey: version === 2 && !corrected && typeof product.comparisonKey === 'string' ? product.comparisonKey || null : null,
      ...(corrected && Array.isArray(product.changes) ? { changes: product.changes.filter(change => change !== 'price_drop') } : {}),
      specLabel
    });
  }
  return [...unique.values()];
}

// Older snapshots occasionally labelled a scheduled date or usage limit as the
// term. Keep a label if the title independently states that same duration.
function reviewStoredTerm(title, label) {
  if (typeof title !== 'string' || !/\d+(?:天|个月|年|小时)/u.test(label)) return label;
  const { claims } = titleDuration(title.normalize('NFKC').toLowerCase());
  const units = { month: '个月', year: '年', day: '天', hour: '小时' };
  const term = claim => claim.value + units[claim.unit];
  const conflicts = new Set(claims.filter(c => c.role === 'calendar_date' || c.role === 'usage_window').map(term));
  if (!conflicts.size) return label;
  for (const claim of claims) if (claim.role === 'duration') conflicts.delete(term(claim));
  const parts = label.split(' · ');
  const remaining = parts.filter(part => !conflicts.has(part));
  return remaining.length === parts.length ? label : remaining.join(' · ') || '规格待核验';
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
