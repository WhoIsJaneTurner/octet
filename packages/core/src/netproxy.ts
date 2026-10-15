import { lookup } from 'node:dns/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP, connect, type Socket } from 'node:net';

/**
 * A tiny allow-list proxy for sandboxed agents. Seatbelt can only allow a network connection by
 * IP and port, never by hostname, so the sandbox lets the agent reach this one loopback port and
 * nothing else; this proxy decides which hostnames get through. It speaks HTTP CONNECT (all HTTPS
 * traffic, including the model API) and refuses plain-HTTP requests.
 */
export interface NetProxy {
  port: number;
  close(): Promise<void>;
}

export interface NetProxyOptions {
  allowHosts: string[];
  /** Called for every refused connection, with the host the agent asked for and why. */
  onDeny?: (host: string, reason: string) => void;
  /** Called when a connection is let through. */
  onAllow?: (host: string) => void;
  /** Allow hosts that resolve to loopback, private or link-local addresses. Tests only. */
  allowPrivate?: boolean;
}

/** `*.example.com` matches subdomains only; a bare name matches exactly. Case-insensitive. */
export function hostAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return patterns.some((p) => {
    const q = p.toLowerCase();
    return q.startsWith('*.') ? h.endsWith(q.slice(1)) && h.length > q.length - 1 : h === q;
  });
}

/** Loopback, private, link-local (cloud metadata) and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const p = ip.split('.').map(Number);
  const [a = 0, b = 0] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function splitHostPort(target: string): { host: string; port: number } | null {
  const m = target.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/);
  if (!m) return null;
  const port = Number(m[3]);
  return port > 0 && port < 65536 ? { host: (m[1] ?? m[2])!, port } : null;
}

export function startNetProxy(opts: NetProxyOptions): Promise<NetProxy> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Plain HTTP is never forwarded: package registries and the model API are HTTPS.
    const host = (() => { try { return new URL(req.url ?? '').hostname; } catch { return req.headers.host ?? '?'; } })();
    opts.onDeny?.(host, 'plain HTTP is not proxied');
    res.writeHead(403, { 'content-type': 'text/plain' }).end('octet sandbox: plain HTTP is not allowed\n');
  });
  // A client that hangs up mid-request is routine (curl timeouts, killed agents); never let it crash the daemon.
  server.on('connection', (s) => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); });
  server.on('connect', async (req: IncomingMessage, client: Socket, head: Buffer) => {
    const target = splitHostPort(req.url ?? '');
    const refuse = (host: string, reason: string) => {
      opts.onDeny?.(host, reason);
      client.end('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\noctet sandbox: host not allowed\r\n');
    };
    if (!target) return refuse(req.url ?? '?', 'malformed CONNECT target');
    if (!hostAllowed(target.host, opts.allowHosts)) return refuse(target.host, 'host is not on the allow-list');
    try {
      const addr = isIP(target.host) ? target.host : (await lookup(target.host)).address;
      if (!opts.allowPrivate && isPrivateAddress(addr)) return refuse(target.host, `resolves to a private address (${addr})`);
      const upstream = connect(target.port, addr);
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.once('connect', () => {
        opts.onAllow?.(target.host);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      const drop = () => { upstream.destroy(); client.destroy(); };
      upstream.on('error', drop);
      client.on('error', drop);
    } catch (e) {
      refuse(target.host, `lookup failed: ${(e as Error).message}`);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        close: () => new Promise<void>((done) => {
          for (const s of sockets) s.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}
