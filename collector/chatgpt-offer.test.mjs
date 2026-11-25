import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChatgptOffer } from './chatgpt-offer.mjs';

const route = (name, categoryName = '', descriptionText = '') => classifyChatgptOffer({ name, categoryName, descriptionText });

test('route the product delivered, including merchant spelling, throughout all three plans', () => {
  for (const [title, plan] of [
    ['ChatGPT Plus 月卡 | 支持 Codex', 'plus'], ['Gp.t Pro20x 成品号｜不支持 Codex', 'pro'],
    ['鸡皮提 Team10X 席位', 'team'], ['OpenAI ChatGPT Business 管理员母号', 'team'],
    ['GPTPLUS 年卡（支持 Codex / Claude Code）', 'plus'], ['GPT-Pro 包月，支持 Codex', 'pro'],
    ['ChatGPT Team，平替 Plus', 'team'], ['ChatGPT Plus｜可用Codex Pro功能', 'plus'],
    ['G!P!T-Plus成品号-周限额，质保一小时内首登，支持登录网页，支持登录codex需接马', 'plus'],
    ['G+p·t Pro 20倍Plus额度', 'pro'],
  ]) {
    const result = route(title);
    assert.deepEqual([result.status, result.plan, result.evidence], ['included', plan, 'title'], title);
  }
  assert.equal(route('长效 10xteam，gmail 邮箱', 'Gp.t Team K12').evidence, 'category');
  assert.equal(route('Team月卡', '账号', '本商品为 ChatGPT Team 席位。支持 Codex').evidence, 'description');
  assert.equal(route('成品号', 'ChatGPT', '交付内容：【ChatGPT Plus】1个月成品号。').plan, 'plus');
});

test('a tool, referral, mixed product, incompatible brand or unrelated ASCII word cannot identify a ChatGPT subscription', () => {
  for (const [title, cat] of [
    ['Steam 成品号', 'ChatGPT Team'], ['【K12】G Team 成品', 'GPT'],
    ['ChatGPT Plus/Pro 二选一'], ['GPT Pro20x / Team 10x'],
    ['ChatGPT Team 优惠码'], ['ChatGPT Plus 充值教程'], ['免费白号 可升级 ChatGPT Pro'],
    ['GPT Plus 好友邀请额度卡密'], ['Claude Pro｜支持 ChatGPT Plus'], ['Gemini Pro 月卡', 'ChatGPT'],
    ['Codex Plus 成品号（兼容 ChatGPT）', 'GPT'], ['Codex Team 月卡', 'ChatGPT Team'],
    ['GPT Plus + Codex Pro 组合包'], ['TeamX5 长效车', 'GPT / Claude Team'],
    ['成品号', 'ChatGPT Plus/Pro'], ['Pro 成品号', 'K12'],
    ['ChatGPT Plus 激活资格号'], ['Team 子号', 'Steam'], ['Google Workspace Business'],
    ['【绑卡-学生认证】plus学生认证 人工绑卡', 'OpenAI Plus'],
    ['4个月plus 只是过学生认证 不过包退', 'OpenAI Plus'],
    ['Team 账号', '账号'], ['Plus（支持 Codex）', 'AI商品'], ['通用账号｜支持 ChatGPT Plus'],
  ]) assert.notEqual(route(title, cat).status, 'included', title);
  assert.equal(route('Team10X 头车', 'Team').status, 'review');
  assert.equal(route('Plus|支持 Codex', '未知').reason, 'brand_unconfirmed');
  assert.equal(route('Codex Team 席位（支持 ChatGPT）', 'GPT').reason, 'codex_product');
  assert.notEqual(route('GPT Plus + Codex Pro 组合包').reason, 'codex_product');
  assert.notEqual(route('Claude Team 和 Codex Team 席位').reason, 'codex_product');
  assert.notEqual(route('Team 卡密', 'GPT', '本商品为 Codex Team 席位。').status, 'included');
});

test('merchant terms keep tier, country, delivery and duration differences visible', () => {
  const ranges = ['$100', '$200', '$500'].map(tier => route('ChatGPT Pro ' + tier + ' 正价代充').specLabel);
  assert.equal(new Set(ranges).size, 3);
  assert.match(route('ChatGPT Pro 100/200/500$ 充值').specLabel, /\$100\/\$200\/\$500 档/u);
  assert.notEqual(route('ChatGPT Pro 10x 智利代充').specLabel, route('ChatGPT Pro 10x 菲律宾代充').specLabel);
  assert.match(route('G PLUS镜像站【周卡】', 'GPT').specLabel, /镜像站 · 1周/u);
  assert.match(route('G PLUS 镜像站(天卡)', 'GPT').specLabel, /镜像站 · 1天/u);
  assert.match(route('GPT Plus 成品号 只能反代').specLabel, /仅反代/u);
  const conditional = route('G!P!T-Plus成品号，支持登录codex需接马', 'GPT', '因二次验证无法使用 Codex，不在质保范围');
  assert.match(conditional.specLabel, /Codex 需手机验证/u);
  assert.doesNotMatch(conditional.specLabel, /不可用 Codex/u);
  assert.doesNotMatch(route('标准周限team没有五小时，不是5X', 'GPT').specLabel, /5小时|5×/u);
  assert.doesNotMatch(route('长效车｜1x team 不保证周限额【非出租席位】', 'GPT').specLabel, /席位/u);
  const base = { shopToken: 'store', goodsKey: 'item', price: 10, stockCount: 3, region: 'US', currency: 'CNY',
    accessMode: 'web_only', feeBasis: 'per_account_total', extraFeeStatus: 'none', unitCount: 1, minQuantity: 1 };
  const proKey = name => classifyChatgptOffer({ ...base, name: 'ChatGPT Pro 成品号 1个月 ' + name }).comparisonKey;
  assert.ok(proKey('100刀 5x'));
  assert.notEqual(proKey('100刀 5x'), proKey('200刀 10x'));
  assert.equal(proKey('100/200/500刀 选档'), null);
  assert.equal(proKey('100刀 智利和菲律宾随机'), null);
  assert.equal(proKey('500刀 只能反代'), null);
});

test('show known specifications and reserve comparable keys for fully declared matching offers', () => {
  const raw = { name: 'ChatGPT Plus 成品号 1个月', shopToken: 'store-one', goodsKey: 'p1', price: 10,
    stockCount: 4, region: 'US', currency: 'CNY', accessMode: 'web_only', feeBasis: 'per_account_total',
    extraFeeStatus: 'none', unitCount: 1, minQuantity: 1 };
  const offer = classifyChatgptOffer(raw);
  assert.ok(offer.comparisonKey);
  assert.equal(classifyChatgptOffer({ ...raw, price: 30, shopToken: 'elsewhere', goodsKey: 'p2' }).comparisonKey, offer.comparisonKey);
  for (const change of [{ region: 'CN' }, { name: 'ChatGPT Plus 成品号 2个月' }, { descriptionText: '不可改密' },
    { currency: '' }, { stockCount: 0 }]) assert.notEqual(classifyChatgptOffer({ ...raw, ...change }).comparisonKey, offer.comparisonKey);
  const rotating = route('GPT Team10X 头车｜质保2小时');
  assert.equal(rotating.comparisonKey, null);
  assert.match(rotating.specLabel, /10×/u);
  assert.match(rotating.specLabel, /头车/u);
  assert.doesNotMatch(rotating.specLabel, /2小时/u);
  assert.match(route('GPT Plus 年卡').specLabel, /年/u);
  assert.equal(route('GPT Pro 账号').comparisonKey, null);
});
