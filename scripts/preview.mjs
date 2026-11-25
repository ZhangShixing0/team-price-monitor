import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

export function createPreviewServer({ siteDir = defaultSite } = {}) {
  return createServer(async (request, response) => {
    const fail = (status) => { response.writeHead(status); response.end(); };
    if (!['GET', 'HEAD'].includes(request.method)) return fail(405);
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const base = await realpath(siteDir);
      if (pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) return fail(404);
      const file = await realpath(resolve(base, '.' + (pathname === '/' ? '/index.html' : pathname)));
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
  const port = Number(process.env.PORT || 8768);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('PORT 必须是 1 至 65535 之间的整数');
  createPreviewServer().listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:' + port + '/'));
}
