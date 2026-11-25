import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runHourly } from '../jobs/hourly.mjs';

const defaultOutput = fileURLToPath(new URL('../site/data/', import.meta.url));

export async function hourlyCycle({ outputDir = defaultOutput, stateDir, signal,
  publishUrl = process.env.PRICE_SITE_URL, token = process.env.PRICE_SITE_TOKEN,
  collectAndPublish = runHourly, upload } = {}) {
  if (Boolean(publishUrl) !== Boolean(token)) throw new Error('云发布需要同时设置 PRICE_SITE_URL 和 PRICE_SITE_TOKEN。');
  if (publishUrl) {
    const url = new URL(publishUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('PRICE_SITE_URL 需要是网站的 HTTPS 地址。');
    }
  }
  const report = await collectAndPublish({ outputDir, stateDir, signal });
  if (report.status !== 'success' || !report.published || !publishUrl) return report;
  try {
    const send = upload || (await import('../hosting/send.mjs')).sendSnapshot;
    const remote = await send({ outputDir, url: publishUrl, token });
    return { ...report, remoteStatus: 'published', remote };
  } catch (error) {
    return { ...report, remoteStatus: 'failed', remoteError: String(error.message || error).replaceAll(token, '[redacted]').slice(0, 400) };
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  try {
    const { values } = parseArgs({ options: { 'output-dir': { type: 'string' }, 'state-dir': { type: 'string' } } });
    const result = await hourlyCycle({ outputDir: values['output-dir'], stateDir: values['state-dir'], signal: controller.signal });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'busy' ? 2 :
      result.status === 'success' && !result.reportError && result.remoteStatus !== 'failed' ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: String(error.message || error) }));
    process.exitCode = 1;
  }
}
