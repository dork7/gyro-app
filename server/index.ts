import https from 'node:https';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import sirv from 'sirv';
import { createServer as createVite } from 'vite';
import { getCert } from './cert';
import { attach, startHeartbeat } from './rooms';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prod = process.argv.includes('--prod');
const port = Number(process.env.PORT ?? 5173);

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

const ips = lanAddresses();
const { key, cert } = getCert(root, ips);

// Static files (production build) or Vite's dev middleware (created after the server
// so Vite's hot-reload socket can share the same HTTPS port).
let handler: (req: any, res: any, next: () => void) => void = (_req, res) => {
  res.statusCode = 503;
  res.end('Starting…');
};
let vite: Awaited<ReturnType<typeof createVite>> | undefined;

const server = https.createServer({ key, cert }, (req, res) => {
  const url = new URL(req.url ?? '/', 'https://localhost');

  if (url.pathname === '/api/info') {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ lan: ips, port }));
    return;
  }
  if (url.pathname === '/pad') req.url = '/pad.html' + url.search; // controller page

  handler(req, res, () => {
    res.statusCode = 404;
    res.end('Not found');
  });
});

if (prod) {
  handler = sirv(resolve(root, 'dist'), { etag: true });
} else {
  vite = await createVite({
    root,
    appType: 'mpa',
    server: { middlewareMode: true, hmr: { server } },
    clearScreen: false,
  });
  handler = vite.middlewares;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (prod) {
    socket.destroy();
  } // in dev, Vite's own listener handles its hot-reload socket
});
wss.on('connection', (ws) => attach(ws));
const heartbeat = startHeartbeat(wss.clients);

server.listen(port, '0.0.0.0', () => {
  const line = '─'.repeat(54);
  console.log(`\n${line}\n  Gyro Fruit Slicer ${prod ? '(production build)' : '(dev)'}\n${line}`);
  console.log(`  Game on this laptop :  https://localhost:${port}`);
  for (const ip of ips) console.log(`  Same, via Wi-Fi/LAN :  https://${ip}:${port}`);
  console.log('\n  Open the game URL, then scan the QR code with your phone.');
  console.log('  The phone will warn about the certificate: accept it once.');
  if (ips.length === 0) console.log('\n  ⚠ No network address found. Connect to Wi-Fi so the phone can reach this laptop.');
  console.log(`${line}\n`);
});

function shutdown(): void {
  clearInterval(heartbeat);
  wss.close();
  server.close();
  void vite?.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
