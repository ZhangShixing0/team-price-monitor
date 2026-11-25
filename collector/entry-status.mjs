import { setTimeout as sleep } from 'node:timers/promises';

// Also runs inside the store page. Only a short status label leaves the page.
export function blockingScreen(doc = null) {
  doc ??= document;
  const title = doc.title.trim();
  const visible = (doc.body?.innerText || '').trim();
  if (/滑动验证|安全验证|人机验证|captcha|security challenge|verify you are human/iu.test(title) ||
      (visible.length <= 600 && /请(?:向右)?(?:按住并)?拖动滑块|请完成(?:滑动|安全|人机)验证|verify you are human/iu.test(visible))) {
    return 'challenge';
  }
  if (/^(?:商家|商户|用户|会员)?登[录入](?:页面)?$|^sign in$/iu.test(title)) return 'login';
  return false;
}

export function observeEntryErrors(page) {
  let network = null;
  let http = null;
  let script = false;
  const essential = type => ['document', 'script', 'fetch', 'xhr'].includes(type);
  const failed = request => {
    if (essential(request.resourceType())) {
      const code = request.failure()?.errorText?.match(/net::ERR_[A-Z_]+/u)?.[0];
      if (code && code !== 'net::ERR_ABORTED') network ??= code;
    }
  };
  const response = result => {
    if (result.status() >= 400 && essential(result.request().resourceType())) http ??= result.status();
  };
  const pageError = () => { script = true; };
  page.on('requestfailed', failed).on('response', response).on('pageerror', pageError);
  return {
    summary() {
      if (network) return `分类列表未加载，页面资源出现网络错误 ${network}。`;
      if (http) return `分类列表未加载，页面资源返回 HTTP ${http}。`;
      if (script) return '分类列表未加载，页面脚本报告运行错误。';
      return '在等待时间内，公开页面没有返回分类列表；具体原因未确认。';
    },
    stop() {
      page.off('requestfailed', failed).off('response', response).off('pageerror', pageError);
    }
  };
}

export async function waitForCategory(page, pendingCategory, observations) {
  // The public entry can render an empty shell at DOMContentLoaded, then set
  // the verification title later. Stop as soon as that screen appears.
  const stop = new AbortController();
  const waitForBlock = async () => {
    while (!stop.signal.aborted) {
      let reason;
      try {
        reason = await page.evaluate(blockingScreen);
      } catch (error) {
        // A normal in-page navigation briefly destroys the preceding document.
        if (!/Execution context was destroyed/iu.test(error.message)) throw error;
      }
      if (reason === 'challenge') throw new Error('公开店铺要求人工验证，本次停止。');
      if (reason === 'login') throw new Error('公开店铺转到登录页，本次停止。');
      await sleep(250, undefined, { signal: stop.signal });
    }
  };
  try {
    const category = pendingCategory.catch(error => {
      if (error.name === 'TimeoutError') throw new Error(observations.summary());
      throw error;
    });
    return await Promise.race([category, waitForBlock()]);
  } finally {
    stop.abort();
  }
}
