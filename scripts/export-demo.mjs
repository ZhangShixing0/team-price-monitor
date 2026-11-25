import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDemoSnapshot } from './demo.mjs';

const site = new URL('../site/', import.meta.url);
const destination = new URL('../docs/demo.html', import.meta.url);

async function readSource(path) {
  return (await readFile(new URL(path, site), 'utf8')).replace(/\r\n/g, '\n');
}

function replaceOnce(source, pattern, replacement) {
  if (!pattern.test(source)) throw new Error('页面入口已改变，请检查单文件导出规则。');
  return source.replace(pattern, () => replacement);
}

const hash = text => " 'sha256-" + createHash('sha256').update(text).digest('base64') + "'";

export async function buildStandaloneDemo() {
  const [template, style, app, catalog] = await Promise.all([
    readSource('index.html'), readSource('style.css'), readSource('app.js'), readSource('catalog-view.mjs')
  ]);
  // The entry module imports only the catalog view. Keeping both in a single
  // inline module also works for browsers that restrict imports from file://.
  const script = replaceOnce(app, /^import \{[^\n]+\} from '\.\/catalog-view\.mjs';/m, catalog.trimEnd());
  if (/<\/script\b/iu.test(script) || /<\/style\b/iu.test(style)) throw new Error('内联代码含有 HTML 结束标签。');
  const data = JSON.stringify(createDemoSnapshot('2020-01-01T00:00:00.000Z')).replace(/</g, '\\u003c');
  const policy = "default-src 'none'; script-src" + hash(script) + hash(data) +
    '; style-src' + hash(style) + "; base-uri 'none'; form-action 'none'; connect-src 'none'";
  let html = replaceOnce(template, /<meta http-equiv="Content-Security-Policy" content="[^"]*">/,
    '<meta http-equiv="Content-Security-Policy" content="' + policy + '">');
  html = replaceOnce(html, /<link rel="stylesheet" href="\.\/style\.css">/, '<style>' + style + '</style>');
  html = replaceOnce(html, /<script src="\.\/app\.js" type="module"><\/script>/,
    '<script id="demo-data" type="application/json">' + data + '</script>\n  <script type="module">' + script + '</script>');
  return html;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await writeFile(destination, await buildStandaloneDemo(), 'utf8');
}
