'use strict';

const http = require('http');
const { performance } = require('perf_hooks');
const target = new URL(process.env.LOAD_URL || 'http://127.0.0.1:3000/api/health');
const requests = Number(process.env.LOAD_REQUESTS || 5000);
const concurrency = Number(process.env.LOAD_CONCURRENCY || 25);
const diagnosticsToken = process.env.DIAGNOSTICS_TOKEN || '';
let issued = 0, completed = 0, failed = 0, peakRss = 0, lastDiagnostics = null;

function request(pathname = target.pathname, headers = {}) {
  return new Promise(resolve => {
    const req = http.get({ hostname: target.hostname, port: target.port, path: pathname, headers, timeout: 5000 }, res => {
      let body = '';
      res.on('data', chunk => { if (body.length < 65536) body += chunk; });
      res.on('end', () => resolve({ ok: res.statusCode < 500, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ ok: false, body: '' }));
  });
}

async function worker() {
  while (issued < requests) {
    issued++;
    const result = await request();
    if (!result.ok) failed++;
    completed++;
  }
}

(async () => {
  const sampler = diagnosticsToken && setInterval(async () => {
    const result = await request('/api/diagnostics', { 'x-diagnostics-token': diagnosticsToken });
    try { lastDiagnostics = JSON.parse(result.body); peakRss = Math.max(peakRss, lastDiagnostics.rss || 0); } catch {}
  }, 25);
  sampler?.unref();
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (sampler) clearInterval(sampler);
  const elapsedSeconds = (performance.now() - started) / 1000;
  console.log(JSON.stringify({ requests, concurrency, failed, seconds: +elapsedSeconds.toFixed(3),
    requestsPerSecond: +(completed / elapsedSeconds).toFixed(1), peakRssBytes: peakRss || null,
    finalDiagnostics: lastDiagnostics }, null, 2));
  process.exitCode = failed ? 1 : 0;
})();
