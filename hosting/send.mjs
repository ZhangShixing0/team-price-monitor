import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

function publishUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('PRICE_SITE_URL 需要 HTTPS 站点地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !['/', '/_publish'].includes(url.pathname)) {
    throw new Error('PRICE_SITE_URL 只接受 HTTPS 站点根地址或 /_publish。');
  }
  url.pathname = '/_publish';
  return url;
}

// Call after committing a complete local round. Re-sending the same round is idempotent.
export async function sendSnapshot({ outputDir, url = process.env.PRICE_SITE_URL,
  token = process.env.PRICE_SITE_TOKEN, request = fetch } = {}) {
  if (!url && !token) return { published: false, skipped: true };
  if (!url || !token) throw new Error('请同时设置 PRICE_SITE_URL 和 PRICE_SITE_TOKEN。');
  const endpoint = publishUrl(url);
  const manifest = JSON.parse(await readFile(join(outputDir, 'manifest.json'), 'utf8'));
  if (!/^[0-9a-f]{64}$/.test(manifest.sha256) || manifest.snapshot !== 'snapshots/' + manifest.sha256 + '.json') {
    throw new Error('本地报价版本地址无效。');
  }
  const post = body => request(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify(body),
  });
  let response = await post({ manifest });
  if (response.status === 428) {
    await response.body?.cancel();
    const snapshot = await readFile(join(outputDir, manifest.snapshot), 'utf8');
    if (createHash('sha256').update(snapshot).digest('hex') !== manifest.sha256) throw new Error('本地报价文件完整性校验失败。');
    response = await post({ manifest, snapshot });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('站点拒绝发布或暂时不可用（HTTP ' + response.status + '）。本地完整报价保留，可再次发送。');
  }
  const receipt = await response.json();
  if (receipt?.published !== true || receipt.sha256 !== manifest.sha256 || receipt.checkedAt !== manifest.checkedAt) {
    throw new Error('站点回执与本轮报价不一致。');
  }
  return { published: true, unchanged: receipt.unchanged === true, checkedAt: receipt.checkedAt, sha256: receipt.sha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === '--output-dir' && args[1] && !args[1].startsWith('--'))) {
      throw new Error('用法：node hosting/send.mjs [--output-dir 报价目录]');
    }
    const outputDir = args.length ? resolve(args[1]) : fileURLToPath(new URL('../site/data/', import.meta.url));
    const result = await sendSnapshot({ outputDir });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
