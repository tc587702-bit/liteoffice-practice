/**
 * serve.mjs — 零依赖静态服务器（开发用）。
 *
 * 只做三件事：正确 MIME、no-store 缓存（改完刷新即生效）、路径穿越防护。
 * 默认只监听 127.0.0.1，不对外暴露。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function createStaticServer(root = ROOT) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      // 路径穿越防护：规范化后必须仍在 root 之内
      const target = normalize(join(root, pathname));
      if (target !== root && !target.startsWith(root + sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      let file = target;
      const st = await stat(file).catch(() => null);
      if (st?.isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'content-length': body.byteLength,
      });
      res.end(body);
    } catch (err) {
      const code = err?.code === 'ENOENT' || err?.code === 'EISDIR' ? 404 : 500;
      res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }).end(`${code} ${err?.code ?? err?.message}`);
    }
  });
}

/** 从端口开始向上找可用端口，返回真实监听端口。 */
export function listen(server, port = 5180, host = '127.0.0.1', tries = 20) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (p) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt++ < tries) tryPort(p + 1);
        else reject(err);
      });
      server.listen(p, host, () => resolve(server.address().port));
    };
    tryPort(port);
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain || process.argv.includes('--serve')) {
  /*
   * 默认只监听 127.0.0.1（不对外暴露）。
   *
   * 想让自己**同局域网的其他人**直接打开（不用拷文件夹），用：
   *   HOST=0.0.0.0 npm run serve      或   $env:HOST='0.0.0.0'; node tools/serve.mjs
   * 然后让对方访问 http://<你的内网IP>:5180/apps/web/
   *
   * 注意两件事：
   *   1. Windows 防火墙可能会弹窗询问，必须允许「专用网络」
   *   2. 这只是把静态文件提供出去，**没有任何鉴权** —— 同一局域网内谁都能打开，
   *      所以别在公共 WiFi 下这么干
   */
  const host = process.env.HOST || '127.0.0.1';
  const port = await listen(createStaticServer(), Number(process.env.PORT ?? 5180), host);
  const shown = host === '0.0.0.0' ? '<本机内网IP>' : host;
  console.log(`LiteOffice dev server: http://${shown}:${port}/`);
  console.log(`  打开工作台: http://${shown}:${port}/apps/web/`);
  if (host === '0.0.0.0') {
    console.log('  已监听所有网卡：同一局域网的其他人可用上面的地址打开（无鉴权，谨慎使用）');
  }
}
