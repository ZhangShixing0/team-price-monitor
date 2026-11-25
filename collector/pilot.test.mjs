import assert from 'node:assert/strict';
import test from 'node:test';
import { readPilotConfig, isPublicTeamOffer } from './pilot.mjs';
import { collectScopes } from './scoped-collector.mjs';
import { EventEmitter } from 'node:events';
import { blockingScreen, observeEntryErrors, waitForCategory } from './entry-status.mjs';

test('a store shell which later shows a slider stops before waiting out the category timeout', async () => {
  let checks = 0;
  const page = new EventEmitter();
  page.evaluate = async fn => fn({ title: ++checks === 1 ? '' : '滑动验证页面', body: { innerText: '' } });
  const observations = observeEntryErrors(page);
  await assert.rejects(waitForCategory(page, new Promise(() => {}), observations), /人工验证/);
  observations.stop();
  assert.equal(checks, 2);
  assert.equal(blockingScreen({ title: '店铺', body: { innerText: '验证码接收类商品' } }), false);
});

test('a category timeout reports an observed resource failure with no request details', async () => {
  const page = new EventEmitter();
  page.evaluate = async () => false;
  const observations = observeEntryErrors(page);
  page.emit('requestfailed', { resourceType: () => 'script', failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }) });
  const timeout = Object.assign(new Error(), { name: 'TimeoutError' });
  await assert.rejects(waitForCategory(page, Promise.reject(timeout), observations), /net::ERR_CONNECTION_RESET/);
  observations.stop();
});

test('the pilot schedules every configured shop and only explicit individual categories', async () => {
  const config = await readPilotConfig();
  assert.equal(config.shops.length, 20);
  assert.equal(config.scopes.length, 36);
  assert.ok(config.scopes.every(scope => scope.categoryId > 0));
  assert.equal(new Set(config.scopes.map(scope => scope.shopToken)).size, 20);
});

test('titles and explicit delivery text qualify, mixed shop directories alone do not', () => {
  const scope = { categoryName: 'Codex-Team/K12/Plus/拼车/点数/镜像' };
  for (const name of ['10Xteam 二车', 'Teamx5 首车', '5x team 质保', '高级team 额度600-1000']) {
    assert.ok(isPublicTeamOffer({ ...scope, name, stockCount: 0 }), name);
  }
  for (const name of ['Steam 家庭组', 'Team K12 成品', 'iCloud邮箱Gplus质保18天月卡',
    '即梦高级会员3万积分成品号', 'team8折优惠码（全球通用)', 'Codex Pro 成品号', 'bugteam 新手教程']) {
    assert.equal(isPublicTeamOffer({ ...scope, name, stockCount: 5 }), false, name);
  }
  assert.ok(isPublicTeamOffer({
    ...scope, name: '会员席位月付', descriptionText: '交付内容：ChatGPT Team 席位'
  }));
});

const scope = { shopToken: 'test', goodsType: 'card', categoryId: 25, categoryName: 'Team' };
const raw = (goodsKey, stockCount) => ({ goodsKey, name: 'Team 10x', stockCount, stockState: stockCount ? 'positive' : 'zero' });
function fake(read) {
  return { allowedTokens: new Set(['test']), minimumIntervalMs: 350,
    init: async () => {}, read };
}

test('collection includes sold-out and paginated products without keyword or stock filtering', async () => {
  const requests = [];
  const collector = fake(async (_path, body) => {
    requests.push(body);
    return { total: 3, products: body.current === 1 ? [raw('a', 0), raw('b', 1)] : [raw('c', 4)] };
  });
  const run = await collectScopes(collector, { scopes: [scope], pageSize: 2 });
  assert.ok(run.complete);
  assert.deepEqual(requests.map(x => [x.current, x.keywords]), [[1, ''], [2, '']]);
  assert.deepEqual(run.products.map(x => x.stockCount), [0, 1, 4]);
});

test('missing totals, repeated IDs and changing page totals are incomplete', async () => {
  for (const second of [{ total: 3, products: [raw('b', 0)] },
    { total: 4, products: [raw('c', 1)] }, { total: null, products: [] }]) {
    const collector = fake(async (_path, body) =>
      body.current === 1 ? { total: 3, products: [raw('a', 0), raw('b', 1)] } : second);
    const run = await collectScopes(collector, { scopes: [scope], pageSize: 2 });
    assert.equal(run.complete, false);
    assert.equal(run.queries[0].complete, false);
  }
});
