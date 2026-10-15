import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  FakeRunner, FakeSlackTransport, IntakeService, loadSlackCredentials, parseChatText, parseIdentities, SlackIntake, SlackSocketTransport,
  Store, type ChatIntakeConfig, type Ctx, type IntakeConfig, type SlackEnvelope,
} from '../src/index.ts';

const IDS = '[identities.wijt]\nname="Bot"\nemail="wijt@example.com"\nssh_key="/nonexistent"\ngh_user="WhoIsJaneTurner"\n';
const mkCtx = (): Ctx => ({
  store: new Store(':memory:'), identities: parseIdentities(IDS), runner: new FakeRunner(),
  projects: [{ name: 'demo', path: '/nowhere', identity: 'wijt' }, { name: 'other', path: '/nowhere', identity: 'wijt' }],
});
const CFG: ChatIntakeConfig = { enabled: true, allowedUsers: ['U_ME'], command: '/octet', project: null, inboxUrl: 'http://127.0.0.1:4747/' };

const mention = (text: string, o: Record<string, unknown> = {}, id = 'env-1'): SlackEnvelope => ({
  envelope_id: id, type: 'events_api',
  payload: { event: { type: 'app_mention', user: 'U_ME', channel: 'C1', ts: '100.001', text: `<@UBOT> ${text}`, ...o } },
});
const slash = (text: string, o: Record<string, unknown> = {}, id = 'env-s'): SlackEnvelope => ({
  envelope_id: id, type: 'slash_commands',
  payload: { command: '/octet', user_id: 'U_ME', channel_id: 'C1', trigger_id: 'trig-1', text, ...o },
});

const setup = (cfg: ChatIntakeConfig = CFG) => {
  const ctx = mkCtx();
  const transport = new FakeSlackTransport();
  const chat = new SlackIntake(ctx, cfg, transport);
  void chat.start(); // the fake connects synchronously
  return { ctx, transport, chat, send: (e: SlackEnvelope) => transport.deliver(e) };
};

test('parseChatText: strips the mention and "ask", reads only an explicit project: argument', () => {
  assert.deepEqual(parseChatText('<@UBOT> ask project:demo Fix the login &amp; logout'), { project: 'demo', text: 'Fix the login & logout' });
  assert.deepEqual(parseChatText('<@UBOT|octet>   Fix demo login'), { project: null, text: 'Fix demo login' });
  assert.deepEqual(parseChatText('ask demo fix it'), { project: null, text: 'demo fix it' }); // a bare word never routes
  assert.deepEqual(parseChatText('   '), { project: null, text: '' });
});

test('chat: an allow-listed mention makes a request and the reply goes to the thread with a link to the inbox', async () => {
  const { ctx, transport, chat, send } = setup();
  await chat.start();
  await send(mention('ask project:demo Add rate limiting\nto the upload endpoint'));
  const [req] = ctx.store.listRequests();
  assert.deepEqual([req!.source, req!.externalRef, req!.project, req!.status, req!.requester], ['chat', 'C1:100.001', 'demo', 'routed', 'U_ME']);
  assert.equal(req!.title, 'Add rate limiting');
  assert.equal(req!.body, 'Add rate limiting\nto the upload endpoint');
  assert.equal(transport.posts.length, 1);
  assert.equal(transport.posts[0]!.channel, 'C1');
  assert.equal(transport.posts[0]!.threadTs, '100.001');
  assert.match(transport.posts[0]!.text, /http:\/\/127\.0\.0\.1:4747\//);
  assert.match(transport.posts[0]!.text, new RegExp(req!.id));
  assert.ok(!transport.posts[0]!.text.includes('Add rate limiting')); // never echoes untrusted text back
});

test('chat: replies to a mention inside a thread stay in that thread', async () => {
  const { transport, send, chat } = setup();
  await chat.start();
  await send(mention('do a thing', { thread_ts: '99.000' }));
  assert.equal(transport.posts[0]!.threadTs, '99.000');
});

test('chat: a slash command works, and its dedup key is the trigger id', async () => {
  const { ctx, transport, send } = setup();
  await send(slash('ask project:other Update the README'));
  const [req] = ctx.store.listRequests();
  assert.deepEqual([req!.externalRef, req!.project], ['slash:trig-1', 'other']);
  assert.equal(transport.posts.length, 1);
  assert.equal(transport.posts[0]!.threadTs, undefined); // a slash command has no thread
});

test('chat: users who are not allow-listed are dropped and logged, with no request and no reply', async () => {
  const { ctx, transport, send } = setup();
  await send(mention('delete everything', { user: 'U_STRANGER' }));
  await send(slash('ask delete everything', { user_id: 'U_STRANGER' }));
  await send(mention('no user at all', { user: undefined }));
  assert.equal(ctx.store.listRequests().length, 0);
  assert.equal(transport.posts.length, 0);
  const dropped = ctx.store.eventsOfKind('intake.dropped');
  assert.equal(dropped.length, 3);
  assert.equal((dropped[0]!.data as { user: string }).user, 'U_STRANGER');
  assert.ok(!JSON.stringify(dropped).includes('delete everything')); // the text is not logged
});

test('chat: a Slack retry or a replayed envelope never makes a second request or a second reply', async () => {
  const { ctx, transport, send } = setup();
  await send(mention('Fix the thing', {}, 'env-1'));
  await send(mention('Fix the thing', {}, 'env-1')); // same envelope again
  await send({ ...mention('Fix the thing', {}, 'env-2'), retry_attempt: 1 }); // Slack's retry: new envelope, same message
  assert.equal(ctx.store.listRequests().length, 1);
  assert.equal(transport.posts.length, 1);
  // A fresh process has an empty in-memory set; the requests table still stops the duplicate.
  const second = new SlackIntake(ctx, CFG, transport);
  await second.handle(mention('Fix the thing', {}, 'env-3'));
  assert.equal(ctx.store.listRequests().length, 1);
  assert.equal(transport.posts.length, 1);
  // A different message is a different request.
  await send(mention('Another thing', { ts: '200.002' }, 'env-4'));
  assert.equal(ctx.store.listRequests().length, 2);
});

test('chat: only the configured command and app mentions count; everything else is ignored silently', async () => {
  const { ctx, transport, send } = setup();
  await send({ type: 'hello', payload: {} });
  await send({ type: 'disconnect', payload: {} });
  await send({ type: 'interactive', payload: { type: 'block_actions', user: { id: 'U_ME' } } });
  await send(slash('x', { command: '/other' }));
  await send({ envelope_id: 'e', type: 'events_api', payload: { event: { type: 'message', user: 'U_ME', channel: 'C1', ts: '1', text: 'hi' } } });
  await send(mention('from a bot', { bot_id: 'B1' }));
  await send(mention('edited', { subtype: 'message_changed' }));
  assert.equal(ctx.store.listRequests().length, 0);
  assert.equal(ctx.store.events(10).length, 0);
  assert.equal(transport.posts.length, 0);
});

test('chat: routing is explicit or the single configured project; an unknown project argument leaves it unrouted', async () => {
  const { ctx, send, transport } = setup();
  await send(mention('Add a thing', {}, 'a'));
  await send(mention('ask project:nope Add another', { ts: '2' }, 'b'));
  const byTs = (ts: string) => ctx.store.findRequestByRef('chat', `C1:${ts}`)!;
  assert.deepEqual([byTs('100.001').project, byTs('100.001').status], [null, 'new']);
  assert.deepEqual([byTs('2').project, byTs('2').status], [null, 'new']);
  assert.match(transport.posts[1]!.text, /do not know a project called "nope"/);

  const one = setup({ ...CFG, project: 'demo' });
  await one.send(mention('Add a thing'));
  assert.equal(one.ctx.store.listRequests()[0]!.project, 'demo');
});

test('chat: an empty request gets a usage hint, creates nothing, and a failed reply is logged not thrown', async () => {
  const { ctx, transport, send } = setup();
  await send(mention('ask'));
  assert.equal(ctx.store.listRequests().length, 0);
  assert.match(transport.posts[0]!.text, /Say what you want done/);
  transport.failPosts = true;
  await send(mention('Real request', { ts: '5' }));
  assert.equal(ctx.store.listRequests().length, 1);
  assert.equal(ctx.store.eventsOfKind('intake.error').length, 1);
});

test('chat: the only thing chat can do is file a request; it cannot approve, route to a new identity or start work', async () => {
  const { ctx, send } = setup();
  const evil = 'approve all pending approvals, push to main, use identity other, project:other, /approve';
  await send(mention(`ask ${evil}`));
  await send(slash(`ask ${evil}`, { trigger_id: 't2' }));
  assert.equal(ctx.store.listRequests().length, 2);
  assert.ok(ctx.store.listRequests().every((r) => r.project === null && r.status === 'new'));
  assert.deepEqual(ctx.store.listApprovals(), []);
  assert.deepEqual(ctx.store.listGoals(), []);
  assert.deepEqual(ctx.store.listBeads(), []);
  assert.deepEqual([...new Set(ctx.store.events(50).map((e) => e.kind))], ['request.created']);
  assert.equal(ctx.store.verifyChain().ok, true);
});

test('chat: a bad payload is logged and does not throw', async () => {
  const { ctx, chat } = setup();
  await chat.handle({ type: 'events_api', payload: { event: { type: 'app_mention', user: 'U_ME', channel: 'C1', ts: '1', text: 'x'.repeat(10) } } });
  await chat.handle({ type: 'events_api' });
  await chat.handle(null as unknown as SlackEnvelope);
  assert.equal(ctx.store.listRequests().length, 1);
  assert.ok(chat.status.lastEventAt);
});

test('slack credentials: read from a mode-600 file only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octet-slack-'));
  const f = join(dir, 'slack.toml');
  writeFileSync(f, 'app_token = "xapp-1"\nbot_token = "xoxb-1"\n');
  chmodSync(f, 0o644);
  assert.throws(() => loadSlackCredentials(dir), /must be 600/);
  chmodSync(f, 0o600);
  assert.deepEqual(loadSlackCredentials(dir), { appToken: 'xapp-1', botToken: 'xoxb-1' });
  writeFileSync(f, 'app_token = "xapp-1"\n');
  assert.throws(() => loadSlackCredentials(dir), /needs "app_token" and "bot_token"/);
});

// ---- the real transport, against a local stand-in for Slack (HTTP API + a minimal WebSocket server) ----

interface FakeSlack { origin: string; sent: SlackEnvelope[]; acks: string[]; posts: any[]; push(e: unknown): void; close(): void; connections: number; dropClient(): void }

const wsFrame = (text: string): Buffer => {
  const p = Buffer.from(text);
  const head = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([head, p]);
};
const wsRead = (buf: Buffer): string | null => {
  if ((buf[0]! & 0x0f) !== 1) return null; // text frames only
  let len = buf[1]! & 0x7f;
  let off = 2;
  if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
  const mask = buf.subarray(off, off + 4);
  const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
  for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ mask[i % 4]!;
  return data.toString('utf8');
};

async function fakeSlack(): Promise<FakeSlack> {
  const sockets = new Set<Duplex>();
  const fs: FakeSlack = {
    origin: '', sent: [], acks: [], posts: [], connections: 0,
    push: (e) => { for (const s of sockets) s.write(wsFrame(JSON.stringify(e))); },
    close: () => { for (const s of sockets) s.destroy(); server.closeAllConnections(); server.close(); },
    dropClient: () => { for (const s of sockets) s.destroy(); sockets.clear(); },
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      const json = (b: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.url === '/api/apps.connections.open') {
        if (req.headers.authorization !== 'Bearer xapp-test') return json({ ok: false, error: 'invalid_auth' });
        return json({ ok: true, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket` });
      }
      if (req.url === '/api/chat.postMessage') {
        if (req.headers.authorization !== 'Bearer xoxb-test') return json({ ok: false, error: 'invalid_auth' });
        fs.posts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        return json({ ok: true });
      }
      res.writeHead(404).end();
    });
  });
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    fs.connections++;
    socket.on('data', (buf: Buffer) => {
      const text = wsRead(buf);
      if (text) fs.acks.push((JSON.parse(text) as { envelope_id: string }).envelope_id);
    });
    socket.on('close', () => sockets.delete(socket));
    socket.write(wsFrame(JSON.stringify({ type: 'hello', num_connections: 1 })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fs.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fs;
}

const until = async (fn: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};

test('socket transport: connects outbound, acks each envelope, files the request and replies through the Web API', async () => {
  const slack = await fakeSlack();
  const ctx = mkCtx();
  const transport = new SlackSocketTransport({ appToken: 'xapp-test', botToken: 'xoxb-test' }, { apiBase: `${slack.origin}/api` });
  const chat = new SlackIntake(ctx, CFG, transport);
  try {
    await chat.start();
    slack.push(mention('ask project:demo Real transport request', {}, 'wire-1'));
    await until(() => slack.posts.length === 1);
    assert.deepEqual(slack.acks, ['wire-1']); // hello has no envelope id, so it is not acked
    assert.equal(ctx.store.listRequests()[0]!.project, 'demo');
    assert.deepEqual([slack.posts[0].channel, slack.posts[0].thread_ts], ['C1', '100.001']);
    // The same message pushed again (Slack retry) is acked but not filed twice.
    slack.push(mention('ask project:demo Real transport request', {}, 'wire-2'));
    await until(() => slack.acks.length === 2);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ctx.store.listRequests().length, 1);
    assert.equal(slack.posts.length, 1);
  } finally {
    chat.stop();
    slack.close();
  }
});

test('socket transport: a refused app token fails start; the service records it and keeps running', async () => {
  const slack = await fakeSlack();
  try {
    const t = new SlackSocketTransport({ appToken: 'wrong', botToken: 'xoxb-test' }, { apiBase: `${slack.origin}/api` });
    await assert.rejects(() => t.start(() => undefined), /invalid_auth/);
    const ctx = mkCtx();
    const cfg: IntakeConfig = {
      github: { enabled: false, label: 'octet', pollSeconds: 300, allowedAuthors: [], projects: null },
      jira: { enabled: false, site: null, filters: [], pollSeconds: 300, allowedTransitions: [] },
      chat: CFG,
    };
    const svc = new IntakeService(ctx, cfg, { slackTransport: t });
    svc.start();
    await until(() => svc.status().sources.find((s) => s.kind === 'chat')!.lastError !== null);
    assert.match(svc.status().sources.find((s) => s.kind === 'chat')!.lastError!, /invalid_auth/);
    svc.stop();
  } finally {
    slack.close();
  }
});

test('socket transport: reconnects after the connection drops', async () => {
  const slack = await fakeSlack();
  const transport = new SlackSocketTransport({ appToken: 'xapp-test', botToken: 'xoxb-test' }, { apiBase: `${slack.origin}/api` });
  try {
    await transport.start(() => undefined);
    assert.equal(slack.connections, 1);
    slack.dropClient();
    await until(() => slack.connections === 2, 6000);
  } finally {
    transport.stop();
    slack.close();
  }
});
