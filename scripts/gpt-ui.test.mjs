import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProducts, availablePlans, groupQuotes, groupsOnPage, hasChange } from '../site/catalog-view.mjs';

const offer = (id, more = {}) => ({
  shopToken: 'store', goodsKey: id, shopName: '商家', title: id,
  brand: 'chatgpt', plan: 'plus', priceSymbol: '￥', price: 9, minQuantity: 1,
  specLabel: '代充 · 月付', form: 'topup', comparisonKey: null, ...more
});
const group = (items, sort = 'price_asc') => groupQuotes(items, sort, item => item.observedAt);

test('历史报价读入时纠正日期和限额误写的时长，保留独立声明的期限', () => {
  const legacyDate = offer('date', { title:'19日8:00左右开踢', specLabel:'19天 · 10× · 头车',
    comparisonKey:'obsolete', changes:['price_drop','restocked'] });
  const rows = normalizeProducts([legacyDate,
    offer('quota',{title:'月卡普通team席位，有周限有5小时 看运气',specLabel:'席位 · 1个月 · 5小时'}),
    offer('valid',{title:'订阅19天，19日8:00开始',specLabel:'席位 · 19天',comparisonKey:'exact'}),
    offer('short',{title:'Team席位5小时',specLabel:'席位 · 5小时'})
  ],2);
  assert.deepEqual(rows.map(p => p.specLabel),['10× · 头车','席位 · 1个月','席位 · 19天','席位 · 5小时']);
  assert.equal(rows[0].comparisonKey,null);
  assert.deepEqual(rows[0].changes,['restocked']);
  assert.equal(rows[2].comparisonKey,'exact');
  assert.equal(legacyDate.specLabel,'19天 · 10× · 头车');
});

test('套餐随品牌切换，商品在店内按 ID 去重', () => {
  const rows = normalizeProducts([offer('a'), offer('a', {price: 6}),
    offer('a', {shopToken: 'second'}), offer('b', {brand: 'codex', plan: 'team'}),
    offer('u', {brand: 'unknown', plan: 'team'})], 2);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].price, 6);
  assert.deepEqual(availablePlans(rows, 'chatgpt', 2), ['plus', 'pro', 'team']);
  assert.deepEqual(availablePlans(rows, 'codex', 2), ['team']);
  assert.deepEqual(availablePlans(rows, '', 2), []);
});

test('同规格组隔离品牌、套餐、币种及不同的比较键', () => {
  const exact = (id, spec = {}) => offer(id, {comparisonKey: 'same', ...spec});
  const rows = [exact('a'), exact('b', {price: 3}), exact('c', {price: null}),
    exact('d', {plan: 'team'}), exact('e', {brand: 'codex'}), exact('f', {priceSymbol: '$'}),
    exact('g', {comparisonKey: 'other'}), offer('partial')];
  const ascending = group(rows);
  assert.equal(ascending.length, 6);
  const ordered = buckets => buckets.find(g => g.products.length === 3).products.map(p => p.price);
  assert.deepEqual(ordered(ascending), [3, 9, null]);
  assert.deepEqual(ordered(group(rows, 'price_desc')), [9, 3, null]);
});

test('规格不全只列原价，可组内排序；年/月、交付、倍率和起购量各自展示', () => {
  const rows = [offer('z'), offer('y', {price: 3}), offer('a', {price: 50}),
    offer('year', {specLabel: '代充 · 年付'}), offer('account', {specLabel: '成品账号 · 月付', form: 'account'}),
    offer('team5', {plan: 'team', specLabel: '席位 · 5×'}), offer('team10', {plan: 'team', specLabel: '席位 · 10×'}),
    offer('batch', {minQuantity: 3}), offer('dollar', {priceSymbol: '$'})];
  const ascending = group(rows);
  assert.equal(ascending.length, 7);
  assert.ok(ascending.every(b => !b.comparable));
  const values = buckets => buckets.find(b => b.products.length === 3).products.map(p => p.price);
  assert.deepEqual(values(ascending), [3, 9, 50]);
  assert.deepEqual(values(group(rows, 'price_desc')), [50, 9, 3]);
});

test('旧快照保留 Team，旧的比较键不进入同规格比价', () => {
  const rows = normalizeProducts([offer('old1', {comparisonKey: 'same'}), offer('old2', {comparisonKey: 'same'})], 1);
  assert.deepEqual(availablePlans(rows, 'chatgpt', 1), ['team']);
  assert.equal(group(rows).length, 2);
  assert.ok(rows.every(p => p.plan === 'team' && p.legacy && !p.comparisonKey));
});

test('本轮变化只显示采集端已确认且与记录一致的事件', () => {
  const changed = offer('a', { changes: ['price_drop', 'restocked'], previousPrice: 12, inStock: true });
  assert.ok(hasChange(changed, 'price_drop'));
  assert.ok(hasChange(changed, 'restocked'));
  assert.equal(hasChange(changed, 'first_seen'), false);
  assert.equal(hasChange({ ...changed, changes: [] }, 'price_drop'), false);
  assert.equal(hasChange({ ...changed, previousPrice: 9 }, 'price_drop'), false);
  assert.equal(hasChange({ ...changed, inStock: false }, 'restocked'), false);
  assert.equal(hasChange({ ...changed, legacy: true }, 'price_drop'), false);
  assert.equal(hasChange(offer('new'), 'first_seen'), false);
  assert.ok(hasChange(offer('new', {changes: ['first_seen']}), 'first_seen'));
});

test('跨页保留规格分组标题及整组数量', () => {
  const rows = [offer('a'), offer('b'), offer('c'), offer('pro', {plan: 'pro'})];
  const result = groupsOnPage(group(rows), 2, 2);
  assert.deepEqual(result.map(g => [g.plan, g.total, g.products.length]), [['plus', 3, 1], ['pro', 1, 1]]);
});
