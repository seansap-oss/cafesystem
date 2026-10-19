// Headless Edge smoke test via CDP — checks each page for console errors / failed requests
const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://localhost:3000';
const PAGES = ['/', '/pos', '/kitchen', '/manager', '/delivery', '/admin', '/track?id=KRM-1&token=x'];

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const port = 9333;
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + port, '--user-data-dir=' + process.env.TEMP + '\\edge-smoke-' + Date.now(),
    'about:blank'
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try { targets = await get('http://127.0.0.1:' + port + '/json/list'); break; } catch (e) {}
  }
  if (!targets) { console.log('FAIL: could not connect to Edge CDP'); proc.kill(); process.exit(1); }

  let pass = 0, fail = 0;
  for (const path of PAGES) {
    const wsUrl = targets[0].webSocketDebuggerUrl;
    const ws = new WebSocket(wsUrl);
    let msgId = 0;
    const pending = new Map();
    const errors = [];
    const send = (method, params) => new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        errors.push(msg.params.entry.text + (msg.params.entry.url ? ' @ ' + msg.params.entry.url : ''));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push((d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text) + ' @ ' + (d.url || ''));
      }
      if (msg.method === 'Network.loadingFailed' && !msg.params.canceled) {
        errors.push('NETWORK FAIL: ' + msg.params.errorText);
      }
    };

    await send('Page.enable');
    await send('Log.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Page.navigate', { url: BASE + path });
    await sleep(4500); // let SPA init, fetches, sockets settle

    // collect any late errors
    await sleep(500);
    const relevant = errors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('ERR_INTERNET_DISCONNECTED') &&
      !e.includes('net::ERR_ABORTED') &&
      !e.includes('track?id=KRM-1') // intentional bad-token page shows 404 in UI, fine
    );
    // the track page intentionally fetches a bogus order — API 404 is expected there
    const filtered = path.startsWith('/track') ? relevant.filter(e => !e.includes('404') && !e.includes('Not found') && !e.includes('Missing order')) : relevant;

    if (filtered.length === 0) { console.log('PASS  ' + path); pass++; }
    else { console.log('FAIL  ' + path + '\n      ' + filtered.slice(0, 5).join('\n      ')); fail++; }
    ws.close();
  }

  proc.kill();
  console.log('');
  console.log('==============================');
  console.log('HEADLESS RESULTS: ' + pass + ' passed, ' + fail + ' failed');
  console.log('==============================');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
