import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const defaultSite = fileURLToPath(new URL('../site/', import.meta.url));
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

export function createPreviewServer({ siteDir = defaultSite, dataDir } = {}) {
  return createServer(async (request, response) => {
    const fail = (status) => { response.writeHead(status); response.end(); };
    if (!['GET', 'HEAD'].includes(request.method)) return fail(405);
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) return fail(404);
      const archiveData = Boolean(dataDir && pathname.startsWith('/data/'));
      if (archiveData && !/^\/data\/(?:manifest\.json|snapshots\/[0-9a-f]{64}\.json)$/.test(pathname)) return fail(404);
      const base = await realpath(archiveData ? dataDir : siteDir);
      const route = archiveData ? pathname.slice('/data'.length) : pathname;
      const file = await realpath(resolve(base, '.' + (route === '/' ? '/index.html' : route)));
      const pathWithinSite = relative(base, file);
      if (!pathWithinSite || pathWithinSite === '..' || pathWithinSite.startsWith('..' + sep) || isAbsolute(pathWithinSite)) return fail(404);
      const type = contentTypes[extname(file)];
      if (!type) return fail(404);
      const data = await readFile(file);
      response.writeHead(200, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-length': data.length
      });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch {
      fail(404);
    }
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { port: { type: 'string' }, 'data-dir': { type: 'string' } } });
  const port = Number(values.port ?? process.env.PORT ?? 8768);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('PORT 必须是 1 至 65535 之间的整数');
  createPreviewServer({ dataDir: values['data-dir'] }).listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:' + port + '/'));
}
