import { classifyProduct } from './classifier.mjs';

// A named feature, a login URL and an email provider cannot establish the
// brand of the subscription being delivered.
const normalize = value => typeof value === 'string'
  ? value.normalize('NFKC').toLowerCase().replace(/[\u200b-\u200f\u2060\ufeff]/gu, '').replace(/\s+/gu, ' ').trim()
  : '';
const gptBrandPattern = '(?:(?:chat[\\s._-]*)?g[\\s.!·_+*-]{0,4}p[\\s.!·_+*-]{0,4}t|鸡皮提|g皮t|[鸡🐔]pt)';
const namedGpt = new RegExp('(?<![a-z0-9])' + gptBrandPattern + '(?=plus|pro|team|business|[0-9]|[^a-z]|$)', 'u');
const openAiPlan = /(?<![a-z0-9])open[\s._-]*ai\s*[-|·]?\s*(?:plus|pro|team|business)(?![a-z])/u;
const codexName = /(?<![a-z0-9])codex(?=\d|plus|pro|team|[^a-z]|$)/u;
const otherBrand = /(?<![a-z0-9])(?:steam|claude(?:[\s_-]*code)?|gemini|google(?:\s*(?:one|ai|workspace))?|microsoft|office|teams|notion|adobe|grok|supergrok|cursor|capcut|netflix|canva|perplexity|deepseek|windsurf|midjourney|copilot)(?![a-z])|克劳德|谷歌(?:会员|家庭|工作空间)|微软(?:会员|团队|全家桶)/u;
const supportPrefix = '(?:不支持|支持|兼容|不适用|适用于?|仅用于|可用于|不可|不能|无法|仅可|可以|可|也能|平替|媲美|并非|不是|不含|非)';
const feature = '(?:' + gptBrandPattern + '|codex|claude(?:[\\s_-]*code)?|cursor|gemini|steam|plus|pro|team|business)(?:[\\s_-]*(?:plus|pro|team|business))?(?![a-z])';
const featureClause = new RegExp(supportPrefix + '\\s*(?:直接|同时|正常|独立)?\\s*(?:使用|访问|登录|登陆|用|开启)?\\s*' + feature + '(?:\\s*(?:[/、和与及+]|以及)\\s*' + feature + ')*', 'gu');
const joinedPlan = new RegExp('(?<![a-z0-9])(' + gptBrandPattern + '|codex)(?=plus|pro|team|business)', 'gu');

function offeredWording(value) {
  return normalize(value).replace(featureClause, ' ')
    .replace(/(\d+(?:[x×]|倍))\s*(?:plus|pro|team)\s*(?:的)?额度/gu, '$1额度')
    .replace(/(?:codex|claude[\s_-]*code)\s*(?:可用|不可用|能用|不能用|无法使用|不支持|需接码|需接马|需要接码|需要接马)/gu, ' ')
    .replace(/(?:google|谷歌|微软|microsoft)\s*(?:邮箱|邮件|mail|email)/gu, ' ')
    .replace(joinedPlan, '$1 ');
}

function plans(text) {
  const result = [];
  if (/(?<![a-z0-9])plus(?![a-z])/u.test(text)) result.push('plus');
  if (/(?<![a-z0-9])pro(?![a-z])/u.test(text)) result.push('pro');
  if (/(?<![a-z0-9])(?:\d+\s*[x×]\s*)?team(?:[\s_-]*(?:[x×]?\d+[x×]?))?(?![a-z0-9])|(?<![a-z0-9])business(?![a-z])|团队(?:版|席位|账号|邀请|号)?|商业版|企业版|工作空间/u.test(text)) result.push('team');
  if (/(?<![a-z0-9])(?:go|free|max|ultra)(?![a-z0-9])/u.test(text)) result.push('other');
  return result;
}

function brands(text) {
  return { gpt: namedGpt.test(text) || openAiPlan.test(text), codex: codexName.test(text), other: otherBrand.test(text) };
}

function declaredProduct(description) {
  const parts = [];
  // A description can list several declarations, in which case they must agree.
  const declaration = /(?:【(?:商品内容|交付内容|所售商品)】\s*[:：]?|(?:本商品|商品内容|交付内容|所售商品|交付商品)\s*(?:为|是|[:：]))\s*[【「\[]?([^。！!；;\n【】「」\[\]]{1,80})/gu;
  for (const match of description.matchAll(declaration)) parts.push(offeredWording(match[1]));
  return parts.join(' | ');
}

function k12Product(text) {
  const positive = text.replace(/(?:不属于|并不是|不是|并非|不含|非)\s*k[\s_-]*12/gu, ' ');
  return /(?<![a-z0-9])k[\s_-]*12(?!\d)|(?:gpt|codex|team)k[\s_-]*12(?!\d)/u.test(positive);
}

function nonSubscription(title, declaration, description) {
  const item = [title, declaration].join(' | ');
  if (/只是(?:过)?学生认证|只(?:提供|出售)(?:学生)?认证资格|(?:这边会提供|即可购买这个)绑卡服务/u.test(description)) return true;
  return /教程|教学|操作指南|新手指南|优惠(?:码|券|资格|链接)|折扣(?:码|券|资格|链接)|资格号|邀请(?:好友|奖励|额度|积分)|好友邀请(?:奖励|额度|积分)|推荐奖励|拉新奖励|绑卡服务|人工绑卡|0刀卡绑定|只是(?:过)?学生认证|接[马码](?:服务|平台|工具)|接码专用|重置(?:卡|码)(?:单卖|单售)|(?:普通账号|免费号|白号|free).{0,40}(?:升级|开通|更适合充|可充)|(?:可开|可升级|可开通).{0,10}(?:plus|pro|team)/u.test(item);
}

const formLabels = { admin: '管理员母号', seat: '席位', activation: '激活码', renewal: '续费码', account: '成品账号', proxy: '反代访问', mirror: '镜像站', topup: '代充或直充', shared: '共享账号', mixed: '多种交付', unknown: '' };
const units = { month: '个月', year: '年', day: '天', hour: '小时' };
const regions = [
  ['US', '美区', /美区|美国区|美国地区/u], ['JP', '日区', /日区|日本/u], ['CN', '国区', /中国区|(?<![美韩英法德泰])国区/u],
  ['PH', '菲律宾', /菲(?:律宾|区)/u], ['CL', '智利', /智利|智区/u], ['EG', '埃及', /埃及|埃区/u],
  ['IN', '印度', /印度|印区/u], ['TR', '土耳其', /土耳其|土区/u], ['ID', '印尼', /印尼/u],
  ['MY', '马来西亚', /马来西亚|马区/u], ['KR', '韩国', /韩国|韩区/u],
  ['HK', '港区', /香港|港区/u], ['TW', '台区', /台湾|台区/u], ['global', '全球', /全球通用|不限地区|全区通用/u],
];

function formOf(title, classification) {
  let form = classification.form;
  const positive = title.replace(/(?:并非|不是|不提供|不含|非)\s*(?:出租|正规|团队)?\s*(?:席位|车位)/gu, '');
  if (/镜像站|镜像访问/u.test(title)) return 'mirror';
  if (form === 'seat' && !/席位|车位|子号邀请|邀请子号/u.test(positive)) form = 'unknown';
  if (form === 'unknown') {
    if (/共享|合租/u.test(title)) form = 'shared';
    else if (/代充|直充|自充|充值/u.test(title)) form = 'topup';
    else if (/成品(?:号|账号)?|发账密|账号密码|帐号密码/u.test(title)) form = 'account';
  }
  return form;
}

function termLabels(title, classification) {
  const duration = classification.duration;
  const terms = new Set();
  for (const [label, pattern] of [['1年', /年卡|年付|包年/u], ['1个月', /月卡|月付|包月/u], ['1周', /周卡|周付|包周/u], ['1天', /天卡|日卡/u]]) {
    if (pattern.test(title)) terms.add(label);
  }
  if (duration) {
    const index = title.indexOf(duration.text);
    const prefix = title.slice(Math.max(0, index - 12), index);
    const suffix = title.slice(index + duration.text.length, index + duration.text.length + 8);
    if (index >= 0 && !/(?:没有|非|无|不含|已活|已开|质保|保修|到账|充值耗时)\s*$/u.test(prefix)
      && !/^(?:额度|上限|限额|限制|窗口|到账|自动|充值到账|内到账|内发货|后踢)/u.test(suffix)
      && !/\d月\d+[日号]/u.test(title)) terms.add(String(duration.value) + units[duration.unit]);
  }
  return [...terms];
}

function offerSpec(title, classification, plan, raw) {
  const original = normalize(raw?.name);
  const form = formOf(title, classification);
  const labels = [formLabels[form]];
  const terms = termLabels(title, classification);
  labels.push(...terms);
  const positive = title.replace(/(?:不是|并非|非|不含|原)\s*\d+\s*[x×倍]/gu, ' ');
  const multiples = new Set([...positive.matchAll(/(\d+)\s*[x×倍]|(?:team|pro)\s*[x×]\s*(\d+)/gu)].map(m => (m[1] || m[2]) + '×'));
  labels.push(...multiples);
  const tiers = new Set();
  if (plan === 'pro') {
    for (const m of title.matchAll(/(?:\bpro[\s_-]*|\$\s*)(100|200|500)(?!\d)|(?<!\d)(100|200|500)\s*(?:\$|美刀|美元|刀|美金|档)/gu)) tiers.add(m[1] || m[2]);
    // Sellers also list several tiers with a currency sign only on the last.
    for (const m of title.matchAll(/(?<!\d)(?:100|200|500)(?:\s*[/、或+]\s*(?:100|200|500))+(?!\d)/gu)) {
      for (const tier of m[0].match(/\d+/gu)) tiers.add(tier);
    }
    if (tiers.size) labels.push([...tiers].sort((a, b) => a - b).map(x => '$' + x).join('/') + ' 档');
  }
  const regionLabels = regions.filter(([code, , pattern]) => code === raw?.region || pattern.test(title)).map(([, label]) => label);
  if (regionLabels.length) labels.push(regionLabels.join('/'));
  if (/哪个区|随机区|区随机/u.test(title)) labels.push('地区随机');
  const proxyOnly = classification.restrictionFacts.proxyOnly || /只能反代|反代专用|只走反代|仅供反代/u.test(title);
  if (proxyOnly && form !== 'proxy') labels.push('仅反代');
  if (classification.restrictionFacts.webOnly) labels.push('仅网页');
  // Descriptions often disclaim support if a future phone check fails. Only
  // a prohibition in the title is safe to present as a product restriction.
  if (/(?:不支持|不能|不可|无法)(?:登录|使用|用)?\s*codex/u.test(original)) labels.push('不可用 Codex');
  else if (/codex\s*需(?:要|自行)?接[马码]/u.test(original)) labels.push('Codex 需手机验证');
  if (/周限额|标准周限/u.test(original)) labels.push('周限额');
  if (/半成品/u.test(original)) labels.push('半成品');
  const rotation = title.match(/头车|首车|[二三23]车|[二三23]轮|长效不踢|非轮换|不轮换/u);
  if (rotation) labels.push(rotation[0]);
  const variantConflict = terms.length > 1 || tiers.size > 1 || multiples.size > 1 || regionLabels.length > 1
    || /多(?:档|种规格)|随机|二选一|选购规格|多规格|混发|任选|半成品/u.test(title);
  const eligible = !variantConflict && form === classification.form && terms.length === 1
    && (!proxyOnly || classification.specification.accessMode === 'proxy_only')
    && (plan === 'plus' || tiers.size === 1 || multiples.size === 1 || /标准席位/u.test(title));
  return { form, specLabel: labels.filter(Boolean).join(' · ') || '规格待核验', eligible };
}

export function classifyChatgptOffer(raw = {}, classification = classifyProduct(raw)) {
  const title = offeredWording(raw?.name);
  const description = normalize(raw?.descriptionText);
  const declaration = declaredProduct(description);
  const category = offeredWording(raw?.declaredCategoryName || raw?.categoryName);
  const titlePlans = plans(title);
  const declaredPlans = plans(declaration);
  const candidates = [...new Set([...titlePlans, ...declaredPlans])];
  const plan = candidates.length === 1 && candidates[0] !== 'other' ? candidates[0] : null;
  const titleBrand = brands(title), declaredBrand = brands(declaration), categoryBrand = brands(category);
  const { form, specLabel, eligible } = offerSpec(title, classification, plan, raw);
  const result = (status, reason, evidence = null) => ({
    status, reason, evidence, plan, brand: status === 'included' ? 'chatgpt' : 'unknown', form, specLabel,
    comparisonKey: eligible && status === 'included' && evidence === 'title' && classification.brand === 'chatgpt'
      && classification.planGroup === plan && classification.comparable ? classification.comparisonKey : null,
  });
  if (!title.trim()) return result('excluded', 'no_product_name');
  if (k12Product(title) || k12Product(declaration)) return result('excluded', 'k12_product');
  if (k12Product(category) && !plans(category).length && !/(?:并非|不是|非)\s*k[\s_-]*12/u.test(title))
    return result('review', 'k12_category');
  if (nonSubscription(title, declaration, description)) return result('excluded', 'not_subscription');
  if (candidates.length > 1) return result('review', 'mixed_plans');
  if (titleBrand.other || declaredBrand.other) return result('excluded', 'other_brand');
  if (titleBrand.codex || declaredBrand.codex) {
    if (titleBrand.gpt || declaredBrand.gpt) return result('review', 'mixed_brands');
    return result('excluded', 'codex_product');
  }
  if (!plan) return result('excluded', 'no_target_plan');
  if (categoryBrand.other && !categoryBrand.gpt || categoryBrand.codex && !categoryBrand.gpt)
    return result('review', 'category_brand_conflict');
  if (titleBrand.gpt) return result('included', 'branded_title', 'title');
  if (declaredBrand.gpt && declaredPlans.includes(plan))
    return result('included', 'declared_product', 'description');
  if (categoryBrand.gpt && !categoryBrand.codex && !categoryBrand.other && titlePlans.includes(plan))
    return result('included', 'branded_category', 'category');
  return result('review', 'brand_unconfirmed');
}
