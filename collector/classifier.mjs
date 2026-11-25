import { createHash } from 'node:crypto';
import { titleDuration } from '../site/catalog-view.mjs';

/**
 * Deterministic routing of unverified merchant claims. This is not a product
 * identity verifier. Category evidence may add a flagged brand inference, but
 * it never becomes verified identity or supplies a purchased duration.
 *
 * Optional structured specification fields: currency, region, accessMode,
 * feeBasis, extraFeeStatus, seatCount/unitCount and minQuantity. Their values
 * are still declarations. `comparable` means eligible for an exact-title,
 * exact-description, same-known-specification comparison, not verified stock
 * or delivery. Consumers must compare only equal non-null comparisonKey values.
 */
const BRAND_LABELS = { chatgpt: 'ChatGPT', codex: 'Codex', claude: 'Claude', cursor: 'Cursor', notion: 'Notion', capcut: 'CapCut', google: 'Google/Gemini', steam: 'Steam', netflix: 'Netflix', adobe: 'Adobe', grok: 'Grok', unknown: '品牌待核验', mixed: '多品牌待核验' };
const PLAN_LABELS = { team_business: 'Team/Business', team: 'Team', business: 'Business', plus: 'Plus', pro: 'Pro', max: 'Max', free: 'Free', ultra: 'Ultra', unknown: '套餐待核验' };
const PLAN_GROUP_LABELS = { plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', max: 'Max', ultra: 'Ultra', free: 'Free', unknown: '套餐待核验' };
const FORM_LABELS = { admin: '管理员母号', seat: '席位/邀请', activation: '激活码或链接', renewal: '续费码', account: '成品账号', proxy: '反代访问', tutorial: '教程/周边', prerequisite: '前置账号', mixed: '交付组合待核验', unknown: '交付形式待核验' };
const UNIT_LABELS = { month: '个月', year: '年', day: '天', hour: '小时' };
const text = value => typeof value === 'string' ? value : '';
const normalize = value => text(value).normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (value, input) => new RegExp(`(?<![a-z0-9])${escapeRegExp(value)}(?![a-z0-9])`, 'u').test(input);
const finiteNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/u.test(value) ? Number(value) : null;
const positiveInteger = value => Number.isSafeInteger(finiteNumber(value)) && finiteNumber(value) > 0 ? finiteNumber(value) : null;
const digest = value => createHash('sha256').update(value).digest('hex');
const planGroup = (plan, teamCandidate = false) => plan === 'team_business' || plan === 'team' || (plan === 'business' && teamCandidate) ? 'team' : ['plus', 'pro', 'business', 'max', 'ultra', 'free'].includes(plan) ? plan : 'unknown';

// A supported tool and a mailbox identify how an offer works, not what is sold.
function productWording(value) {
  return value.replace(/(?:不支持|支持|兼容|无法|不能|不可|可以|可|仅能|也能)(?:直接)?(?:使用|访问|登录|登陆|用)?\s*(?:codex|chatgpt|gpt|claude(?:[\s_-]*code)?|cursor)(?![a-z])/gu, ' ')
    .replace(/(?:非|并非|不是|不含)\s*(?:codex|chatgpt|gpt|claude(?:[\s_-]*code)?|cursor)(?![a-z])/gu, ' ')
    .replace(/(?:google|谷歌|微软|microsoft)(?:\s*(?:邮箱|邮件|mail|email))/gu, ' ');
}

function titleBrands(title, teamIdentity = false) {
  const brands = new Set();
  if (teamIdentity) title = productWording(title);
  const codex = teamIdentity ? /(?<![a-z0-9])codex(?:\d+)?(?![a-z0-9])/u.test(title) : word('codex', title);
  if (word('chatgpt', title) || word('gpt', title) || (word('openai', title) && !(teamIdentity && codex))) brands.add('chatgpt');
  if (codex && !/无法(?:使用|用)?\s*codex|不能(?:使用|用)?\s*codex|不支持\s*codex/u.test(title)) brands.add('codex');
  for (const value of ['claude', 'notion', 'capcut', 'steam', 'netflix', 'adobe']) if (word(value, title)) brands.add(value);
  if (/(?<![a-z0-9])claude[\s_-]*code(?![a-z0-9])/u.test(title)) brands.add('claude');
  if (teamIdentity && word('cursor', title)) brands.add('cursor');
  if (teamIdentity && title.includes('克劳德')) brands.add('claude');
  if (/google\s+ai|gemini|谷歌\s*(?:ai|会员)|谷歌.*(?:家庭组|会员权益)/u.test(title)) brands.add('google');
  if (teamIdentity && /(?:\bgoogle\b|谷歌)\s*(?:workspace|one|team|business|工作空间)/u.test(title)) brands.add('google');
  if (word('grok', title) || title.includes('supergrok')) brands.add('grok');
  // Gmail registration and an Opus capability mention are not product brands.
  if (brands.has('chatgpt') && brands.has('codex') && !(teamIdentity && /\bcodex\s+(?:team|账号|账户)/u.test(title))) brands.delete('codex');
  return [...brands];
}

function categoryBrandHints(categoryName) {
  const category = productWording(normalize(categoryName));
  const brands = new Set(titleBrands(category, true));
  if (/\b(?:google|gemini)\b|谷歌/u.test(category)) brands.add('google');
  if (/\bmicrosoft\b|\boffice\b|\bteams\b|微软/u.test(category)) brands.add('microsoft');
  if (brands.has('chatgpt') && word('openai', category) && !/chatgpt|\bgpt\b|\b(?:team|k12|business)\b|团队/u.test(category)) brands.delete('chatgpt');
  return [...brands];
}

function teamBrandHint(title, description, categoryBrands, codexUnsupported) {
  const signals = new Map();
  for (const key of categoryBrands) signals.set(key, 'category');
  if (/(?:g皮t|鸡皮提|[🐔鸡]pt)(?![a-z])/u.test(title)) signals.set('chatgpt', 'title_alias');
  // Only an explicit description of the delivered product supplies a hint.
  // Incidental links, supported models and login instructions do not qualify.
  const declaration = /(?:【商品内容】|(?:本商品|商品内容|交付内容|交付商品|所售商品)\s*(?:为|是|[:：]))\s*(?:实时测活验证的\s*)?(chatgpt|codex|claude|cursor|notion|gemini)\s*(?:team|business|团队)(?![a-z])/gu;
  for (const match of description.matchAll(declaration)) {
    const key = match[1] === 'gemini' ? 'google' : match[1];
    if (!signals.has(key)) signals.set(key, 'description');
  }
  if (signals.size !== 1 || (signals.has('codex') && codexUnsupported)) return null;
  const [[brand, source]] = signals;
  return { brand, source };
}

function hasTeamName(value) {
  return /(?<![a-z0-9])(?:\d+\s*x\s*)?team(?:\s*[-_]?\s*\d+\s*x?|\s*x\s*\d+)?(?![a-z0-9])|团队(?:版|席位|车位|账号|邀请|号)?|工作空间|\bworkspace\b|\bbusiness\b|商业版|企业版/u.test(value);
}

// K12 is a separate offer type for this directory, even when a seller writes
// "Team" beside it. A K12-only source category conflicts with a generic Team
// title; shared K12/Team categories still require checking each actual item.
// Explicit negations and incidental description links are not positive claims.
function isK12Offer(title) {
  const positive = title.replace(/(?:并不是|并非|不是|不属于|不含|非)\s*k[\s_-]*12(?!\d)/gu, ' ');
  return /(?<![a-z0-9])k[\s_-]*12(?!\d)|(?:team|chatgpt|gpt|codex)k[\s_-]*12(?!\d)/u.test(positive);
}

function isReferralReward(title, description) {
  // A seat invitation delivers membership; a referral credit sells a reward
  // for inviting somebody else. Mixed Team categories cannot equate the two.
  const offered = title.replace(/(?:并不是|并非|不是|不含|不提供|非)\s*(?:好友邀请|邀请好友|邀请|推荐|拉新)(?:奖励|额度(?:增加|赠送)?|积分|点数)/gu, ' ');
  if (!/邀请好友|好友邀请|邀请奖励|推荐奖励|拉新奖励/u.test(offered)) return false;
  const titleReward = /(?:邀请好友|好友邀请)[^。！!；;]{0,20}(?:奖励|额度(?:增加|赠送)|积分|点数)|(?:邀请|推荐|拉新)奖励/u.test(offered);
  const declaredReward = /(?:本商品|商品内容|交付内容|所售商品)\s*(?:为|是|[:：])[^。！!；;]{0,80}(?:好友邀请|邀请好友)[^。！!；;]{0,30}(?:额度|奖励|积分|点数)/u.test(description);
  return titleReward || declaredReward;
}

function hasMixedTeamPlans(title) {
  const pair = /(?<![a-z0-9])(?:(?:plus|pro|free|go)\s*(?:[/|]|或)\s*team(?:\s*[-_]?\s*\d+\s*x?|\s*x\s*\d+)?|team(?:\s*[-_]?\s*\d+\s*x?|\s*x\s*\d+)?\s*(?:[/|]|或)\s*(?:plus|pro|free|go))(?![a-z0-9])/gu;
  for (const match of title.matchAll(pair)) {
    const prefix = title.slice(Math.max(0, match.index - 16), match.index);
    if (!/(?:不支持|支持|兼容|适用(?:于)?|可用于)\s*$/u.test(prefix)) return true;
  }
  return false;
}

function restrictions(title, description, durationClaims) {
  const all = `${title}\n${description}`;
  const feePositiveText = all.replace(/无额外(?:费用|收费)|不另收费/gu, '');
  const scheduled = /踢/u.test(all.replace(/(?:不|不会|永不)踢/gu, '')) || /定时移除|到期移除/u.test(all);
  const proxy = /仅反代|反代无账密|仅提供\s*(?:sub2|cpa)|仅提供[^\n]{0,12}cpa/u.test(all);
  const web = /只能用网页|仅(?:限)?网页|只可网页/u.test(all);
  const facts = {
    proxyOnly: proxy,
    webOnly: web,
    codexUnsupported: /无法(?:使用|用)?\s*codex|不能(?:使用|用)?\s*codex|不支持\s*codex|不可(?:使用|用)?\s*codex/u.test(all),
    noAccountCredentials: /无账密|不提供(?:账号|账密)/u.test(all),
    scheduledRemoval: scheduled,
    usageWindow: durationClaims.some(claim => claim.role === 'usage_window') ||
      /\d+\s*(?:小时|h)\s*(?:限制|限额|窗口)/u.test(all),
    indefiniteDurationClaim: /长效|长期|用到空间炸|不踢/u.test(all),
    rotatedOrOvernight: /二车|2车|三轮|过夜/u.test(all),
    qualityWarrantyExcluded: /不(?:质)?保[^\n]{0,15}(?:降智|降职|限流)/u.test(all),
    promotionalPrice: /优惠码|优惠券|减免|首月优惠|新人价/u.test(all),
    monthlyFeeMention: /[/／]\s*月|每月[^\n]{0,6}(?:元|美元|美金|刀)/u.test(all),
    extraFeeMention: /另(?:需|付|收)|额外(?:费用|收费|付费)|子号[^\n]{0,12}(?:美金|美元|\$)/u.test(feePositiveText),
  };
  const labels = [];
  for (const [key, label] of Object.entries({ proxyOnly: '仅反代访问', webOnly: '仅网页访问', codexUnsupported: '不可使用Codex', noAccountCredentials: '不提供账号密码', scheduledRemoval: '定时移出，完整到期时间待核验', usageWindow: '存在用量窗口，非订阅时长', indefiniteDurationClaim: '长效承诺，期限待核验', rotatedOrOvernight: '轮转或过夜权益', qualityWarrantyExcluded: '不保降智或限流', promotionalPrice: '优惠计价待核验', monthlyFeeMention: '月费描述不代表购买时长', extraFeeMention: '可能存在额外费用' })) if (facts[key]) labels.push(label);
  return { facts, labels };
}

function explicitSpecification(product, title, form, facts) {
  let titleRegion = null;
  if (/美区|美国区|美国地区/u.test(title)) titleRegion = 'US';
  if (/中国区|国区/u.test(title)) titleRegion = titleRegion && titleRegion !== 'CN' ? 'mixed' : 'CN';
  if (/日区|日本区/u.test(title)) titleRegion = titleRegion ? 'mixed' : 'JP';
  if (/全球通用|不限地区|不限区/u.test(title)) titleRegion = titleRegion ? 'mixed' : 'global';
  const region = text(product.region).trim() || titleRegion;
  const regionConflict = Boolean(titleRegion && text(product.region) && product.region !== titleRegion);
  const currencyInTitle = /人民币|\bcny\b|\brmb\b/u.test(title) ? 'CNY' : /美元|美金|\busd\b/u.test(title) ? 'USD' : null;
  const currency = text(product.currency).toUpperCase() || currencyInTitle;
  const currencyConflict = Boolean(currencyInTitle && text(product.currency) && currencyInTitle !== product.currency.toUpperCase());
  const accessInTitle = facts.proxyOnly ? 'proxy_only' : facts.webOnly ? 'web_only' : /网页(?:和|与|及|\/)codex(?:均可|双用|可用)|codex(?:和|与|及|\/)网页(?:均可|双用|可用)/u.test(title) ? 'web_and_codex' : null;
  const accessMode = ['web_only', 'proxy_only', 'web_and_codex', 'api_only'].includes(product.accessMode) ? product.accessMode : accessInTitle;
  const accessConflict = Boolean(accessInTitle && accessMode !== accessInTitle) || (accessMode === 'web_and_codex' && facts.codexUnsupported) || (facts.proxyOnly && facts.webOnly);
  const seatMatch = title.match(/(?<count>\d+)\s*(?:个|人)?\s*席位/u);
  const seatTitleCount = seatMatch ? Number(seatMatch.groups.count) : /单人席位|单席位/u.test(title) ? 1 : null;
  const seatCount = positiveInteger(product.seatCount) ?? seatTitleCount;
  const unitCount = ['seat', 'admin'].includes(form) ? seatCount : positiveInteger(product.unitCount) ?? (/单号|单个账号|1个账号/u.test(title) && form === 'account' ? 1 : null);
  const quantityUnit = ['seat', 'admin'].includes(form) ? 'seat' : form === 'account' ? 'account' : ['activation', 'renewal'].includes(form) ? 'code' : form === 'proxy' ? 'access' : null;
  const feeBasis = ['total', 'per_seat_total', 'per_account_total', 'per_code_total', 'bundle_total'].includes(product.feeBasis) ? product.feeBasis : /每席位总价/u.test(title) ? 'per_seat_total' : /每账号总价/u.test(title) ? 'per_account_total' : /(?:实付)?总价/u.test(title) ? 'total' : null;
  const noExtraFee = product.extraFeeStatus === 'none' || /无额外费用|无额外收费|不另收费/u.test(title);
  return { currency, region, accessMode, feeBasis, extraFeeStatus: noExtraFee && !facts.extraFeeMention ? 'none' : 'unknown_or_extra', unitCount, quantityUnit, seatCount, minQuantity: positiveInteger(product.minQuantity), conflicts: { region: regionConflict || region === 'mixed', currency: currencyConflict, access: accessConflict, quantity: Boolean(positiveInteger(product.seatCount) && seatTitleCount && product.seatCount !== seatTitleCount) } };
}

export function classifyProduct(input = {}) {
  const product = input && typeof input === 'object' ? input : {};
  const originalTitle = text(product.name);
  const title = normalize(originalTitle);
  const description = normalize(product.descriptionText);
  const sourceCategory = normalize(product.declaredCategoryName) || normalize(product.categoryName);
  // Team10X, team 5x, 团队车位 and 工作空间 are common merchant aliases.
  const titleTeamEvidence = hasTeamName(title);
  const descriptionTeamEvidence = /(?<![a-z0-9])team(?:\s*[-_]?\s*\d+\s*x?|\s*x\s*\d+)?(?![a-z0-9])|团队(?:版|席位|车位|账号|邀请|号)?|工作空间|workspace/u.test(description);
  const categoryTeamEvidence = hasTeamName(sourceCategory);
  const titleDeliverySignal = /席位|车位|账号|子号|母号|管理员|邀请|共享|成品|充值|激活|续费|订阅|卡密|代充/u.test(title);
  const brands = titleBrands(title, titleTeamEvidence);
  const brand = brands.length > 1 ? 'mixed' : brands[0] ?? 'unknown';
  const typo = /(?<![a-z0-9])(?:ghatcpt|cpt)(?![a-z0-9])/u.test(title);
  const team = titleTeamEvidence;
  const business = word('business', title);
  const chineseTeam = title.includes('团队');
  const compoundTeam = /teamplus|bugteam/u.test(title);
  let plan = 'unknown';
  if (team || business || chineseTeam) plan = brand === 'chatgpt' ? 'team_business' : business ? 'business' : 'team';
  else for (const candidate of ['plus', 'pro', 'free', 'ultra', 'max']) if (word(candidate, title)) { plan = candidate; break; }
  const parsedDuration = titleDuration(title);
  const { facts, labels: restrictionLabels } = restrictions(title, description, parsedDuration.claims);
  const tutorial = /教程|教学|新手指南|使用指南|操作说明/u.test(title);
  const prerequisite = /team.{0,5}资格号|(?:\bfree\b|免费).{0,90}(?:可(?:开|用|加入|升级)|能(?:开通|加入)).{0,12}team/u.test(title);
  const admin = /母号|管理员|管理后台/u.test(title);
  const seat = /席位|车位|子号邀请|邀请子号/u.test(title);
  const renewal = title.includes('续费码');
  const activation = /激活码|激活链接|兑换码/u.test(title) || word('cdk', title);
  const account = /成品号|成品账号/u.test(title);
  let form = tutorial ? 'tutorial' : prerequisite ? 'prerequisite' : facts.proxyOnly ? 'proxy' : renewal ? 'renewal' : activation && account ? 'mixed' : activation ? 'activation' : admin ? 'admin' : seat ? 'seat' : account ? 'account' : 'unknown';
  const duration = parsedDuration.duration;
  const spec = explicitSpecification(product, title, form, facts);
  const categoryOnlyBlocked = categoryTeamEvidence && /\b(?:free|premium|pro|plus|ultra|go)\b|充值|代充/u.test(title) && !titleTeamEvidence;
  const hasTeamSignal = titleTeamEvidence || (categoryTeamEvidence && titleDeliverySignal);
  const categoryBrands = hasTeamSignal ? categoryBrandHints(sourceCategory) : [];
  const couponOnly = /team\s*优惠码|(?:优惠码|减金额码).{0,6}(?:减免|减金额)/u.test(title) || /下单后发货.{0,6}凭借优惠码去.{0,5}下单/u.test(description);
  const referralReward = isReferralReward(title, description);
  const nonPlan = tutorial || prerequisite || couponOnly || referralReward || /(?:0刀卡绑定|绑卡服务)/u.test(title);
  const genericEnterprise = /企业版|商业版/u.test(title) && !/team|business|团队|工作空间/iu.test(title) && brand === 'unknown' && categoryBrands.length === 0;
  const k12Offer = isK12Offer(title);
  const mixedTeamPlans = hasMixedTeamPlans(title);
  const explicitlyNotK12 = /(?:并不是|并非|不是|不属于|不含|非)\s*k[\s_-]*12(?!\d)/u.test(title);
  const categoryK12Conflict = isK12Offer(sourceCategory) && !categoryTeamEvidence && !explicitlyNotK12;
  // CC can name a reseller/channel, so do not turn every occurrence into Claude.
  // In a subscription name such as "cc team pro", its identity is ambiguous;
  // a broad OpenAI category cannot establish which product the seller means.
  const ambiguousBrandAlias = brand === 'unknown' && !categoryBrands.some(key => !['chatgpt', 'codex'].includes(key))
    && /(?<![a-z0-9])cc\s+team\s+(?:pro|max)(?![a-z])/u.test(productWording(title));
  const contextEligible = hasTeamSignal && !categoryOnlyBlocked && !compoundTeam && !genericEnterprise && !nonPlan && !k12Offer && !categoryK12Conflict && !mixedTeamPlans && !ambiguousBrandAlias;
  const hint = contextEligible && titleTeamEvidence && brand === 'unknown'
    ? teamBrandHint(title, description, categoryBrands, facts.codexUnsupported)
    : null;
  const inferredBrand = hint && BRAND_LABELS[hint.brand] ? hint.brand : null;
  const brandSource = hint?.source ?? (brands.length === 1 ? 'title' : brands.length > 1 ? 'mixed' : null);
  const effectiveBrand = inferredBrand || brand;
  const otherBrand = key => !['chatgpt', 'codex', 'unknown'].includes(key);
  const competingBrand = hasTeamSignal && (brands.some(otherBrand) || categoryBrands.some(otherBrand) || otherBrand(effectiveBrand) || /\b(?:microsoft|office|teams)\b/u.test(productWording(title)));
  const teamCandidate = contextEligible && !competingBrand;
  if (teamCandidate && plan === 'unknown') plan = 'team';
  let teamExclusionReason = null;
  if (hasTeamSignal && !teamCandidate) {
    if (k12Offer) teamExclusionReason = '标题明确为 K12 商品，不纳入 Team 套餐。';
    else if (categoryK12Conflict) teamExclusionReason = '原店商家分类仅标示 K12，与 Team 标题冲突，暂不纳入 Team 套餐。';
    else if (referralReward) teamExclusionReason = '交付内容为好友邀请奖励或额度卡密，不是 Team 席位权益。';
    else if (mixedTeamPlans) teamExclusionReason = '标题并列其他套餐与 Team，实际交付套餐或可选规格未明确，暂不归入纯 Team。';
    else if (ambiguousBrandAlias) teamExclusionReason = 'CC Team 套餐的品牌缩写有歧义，需核验所售产品。';
    else if (competingBrand) teamExclusionReason = '商品标题或商家分类指向其他产品。';
    else if (nonPlan) teamExclusionReason = '交付内容是前置资格、教程、优惠或服务。';
    else teamExclusionReason = '商品标题或分类不足以识别为 Team 套餐。';
    if (['team', 'team_business', 'business'].includes(plan)) plan = prerequisite && word('free', title) ? 'free' : 'unknown';
  }
  const reviewReasons = [];
  if (!title) reviewReasons.push('商品标题缺失。');
  if (brand === 'unknown' && !hint) reviewReasons.push(typo ? '品牌拼写或缩写有歧义。' : '商品品牌证据不足。');
  if (brand === 'mixed') reviewReasons.push('标题存在多个产品品牌，可能是组合或兼容说明。');
  if (brand === 'codex' && (team || business)) reviewReasons.push('Codex相关Team权益不等于已确认的ChatGPT Business规格。');
  if (plan === 'unknown' || compoundTeam) reviewReasons.push('套餐称呼不明确或包含拼接名称。');
  if (teamExclusionReason) reviewReasons.push(teamExclusionReason);
  if (['unknown', 'mixed'].includes(form)) reviewReasons.push('交付形式未明确或存在多个交付方式。');
  if (['tutorial', 'prerequisite'].includes(form)) reviewReasons.push(form === 'tutorial' ? '教程或周边提及套餐，不等于交付套餐权益。' : '前置免费账号可开Team，不等于已包含Team权益。');
  if (!duration) reviewReasons.push('订阅时长未明确；质保、月费和用量窗口不能替代。');
  if (parsedDuration.ambiguous) reviewReasons.push('标题包含期限范围或多个不同期限。');
  if (facts.scheduledRemoval || facts.indefiniteDurationClaim || facts.rotatedOrOvernight) reviewReasons.push('移出时间、轮转或长效条件未形成明确可比期限。');
  if (facts.usageWindow) reviewReasons.push('存在用量窗口，尚未验证其额度和恢复方式。');
  if (facts.promotionalPrice || facts.monthlyFeeMention || facts.extraFeeMention) reviewReasons.push('优惠、月费或额外费用与列表价格的关系待核验。');
  for (const [field, label] of [['currency', '币种'], ['region', '地区'], ['accessMode', '访问方式'], ['feeBasis', '计价口径'], ['unitCount', '每份数量'], ['minQuantity', '最小购买量']]) if (!spec[field]) reviewReasons.push(`${label}未明确。`);
  if (spec.extraFeeStatus !== 'none') reviewReasons.push('是否包含额外费用未明确。');
  if (Object.values(spec.conflicts).some(Boolean)) reviewReasons.push('标题与结构化规格字段存在冲突。');
  const descriptionBrands = titleBrands(description).filter(value => value !== brand && !(brand === 'chatgpt' && value === 'codex'));
  if (descriptionBrands.length && !['unknown', 'mixed'].includes(brand)) reviewReasons.push('说明中出现其他品牌，需核对是否只是功能提及或组合商品。');
  if (descriptionBrands.length && brand === 'unknown') reviewReasons.push(`说明提供${descriptionBrands.map(value => BRAND_LABELS[value]).join('/')}品牌线索，但标题证据不足，仍待核验。`);
  if (inferredBrand) reviewReasons.push(`疑似${BRAND_LABELS[inferredBrand]}，品牌归属待核验。`);
  if (finiteNumber(product.price) === null || finiteNumber(product.price) <= 0) reviewReasons.push('有效成交价格未明确。');
  if (!text(product.shopToken) || !text(product.goodsKey)) reviewReasons.push('缺少店铺或商品稳定标识。');
  const declaredPriceKey = reviewReasons.length === 0 ? `declared-spec-v1:${digest(JSON.stringify({ title, description, brand, plan, form, duration: { value: duration.value, unit: duration.unit }, spec, restrictions: facts, goodsType: text(product.goodsType) || null }))}` : null;
  if (finiteNumber(product.stockCount) === null || finiteNumber(product.stockCount) <= 0) reviewReasons.push('当前可购买库存未明确或不足。');
  const comparable = reviewReasons.length === 0;
  const comparisonKey = comparable ? declaredPriceKey : null;
  // Aliases aid discovery, never overwrite the product's brand or eligibility.
  // Explicit other brands retain their literal titles without ChatGPT aliases.
  const aliases = teamCandidate ? 'team business 团队 工作空间' : '';
  const searchBrand = hasTeamSignal && !['unknown', 'mixed'].includes(effectiveBrand) ? effectiveBrand : '';
  const searchText = [title, aliases, searchBrand].filter(Boolean).join(' ');
  return {
    brand, inferredBrand, brandInferred: Boolean(inferredBrand), brandSource, plan, planGroup: planGroup(plan, teamCandidate), form, duration,
    label: [BRAND_LABELS[brand], PLAN_LABELS[plan], FORM_LABELS[form], duration ? `${duration.value}${UNIT_LABELS[duration.unit]}` : '期限待核验'].join(' · '),
    restrictionLabels,
    confidence: comparable ? 'declared' : 'needs_review',
    comparable,
    comparisonKey,
    ...(!comparable && declaredPriceKey && finiteNumber(product.stockCount) === 0 ? { declaredPriceHistoryKey: declaredPriceKey } : {}),
    reviewReasons,
    searchText,
    specification: spec,
    durationClaims: parsedDuration.claims,
    restrictionFacts: facts,
    brandEvidence: { titleBrands: brands, categoryBrands, descriptionBrandHints: titleBrands(description), descriptionHintsAreUnverified: true, inferredBrand, inferenceSource: brandSource },
    claimsVerified: false,
    comparisonNote: comparable ? '仅允许同标题、同说明及已知规格完全一致的商家声明之间比较，实际权益尚未验证。' : '规格存在未知项，价格只能作为原始报价，不能宣称同规格最低价。',
    teamCandidate: Boolean(teamCandidate),
    teamEvidence: { title: Boolean(titleTeamEvidence), description: Boolean(descriptionTeamEvidence), category: Boolean(categoryTeamEvidence), competingBrand: Boolean(competingBrand), categoryK12Conflict: Boolean(categoryK12Conflict), exclusionReason: teamExclusionReason, exclusionCode: hasTeamSignal && k12Offer ? 'k12_offer' : hasTeamSignal && categoryK12Conflict ? 'k12_category_conflict' : hasTeamSignal && referralReward ? 'referral_reward' : hasTeamSignal && mixedTeamPlans ? 'mixed_plan_offer' : hasTeamSignal && ambiguousBrandAlias ? 'ambiguous_brand_alias' : null },
  };
}

export { BRAND_LABELS, PLAN_GROUP_LABELS, planGroup };

/** Optional search helper. ASCII token boundaries prevent team matching steam. */
export function matchesSearchText(searchText, query) {
  const haystack = normalize(searchText);
  return normalize(query).split(/\s+/u).filter(Boolean).every(term => /^[a-z0-9]+$/u.test(term) ? word(term, haystack) : haystack.includes(term));
}
