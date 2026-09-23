'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Semaphore, startNonOverlappingJob } = require('../lib/runtime-guards');
const BoundedFileSessionStore = require('../lib/bounded-file-session-store');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('periodic jobs never overlap and release their timer', async () => {
  let active = 0, peak = 0, runs = 0;
  const before = process._getActiveHandles().length;
  const job = startNonOverlappingJob(async () => {
    active++; peak = Math.max(peak, active); runs++;
    await sleep(35);
    active--;
  }, 5, { runImmediately: true });
  await sleep(90);
  job.stop();
  await sleep(45);
  assert.equal(peak, 1);
  assert.ok(runs >= 2);
  assert.ok(process._getActiveHandles().length <= before + 1);
});

test('semaphore bounds active work and rejects an overflowing queue', async () => {
  const semaphore = new Semaphore(2, 2);
  const releases = await Promise.all([semaphore.acquire(), semaphore.acquire()]);
  const queued = [semaphore.acquire(), semaphore.acquire()];
  await assert.rejects(semaphore.acquire(), err => err.code === 'QUEUE_FULL');
  releases.forEach(release => release());
  (await Promise.all(queued)).forEach(release => release());
  assert.equal(semaphore.active, 0);
});

test('file sessions persist, expire, and remain bounded', async t => {
  const dir = path.join(__dirname, '.tmp-sessions-' + process.pid);
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new BoundedFileSessionStore({ dir, maxSessions: 3, ttlMs: 50, sweepIntervalMs: 10000 });
  t.after(() => store.close());
  const set = (id, value) => new Promise((resolve, reject) => store.set(id, value, err => err ? reject(err) : resolve()));
  const get = id => new Promise((resolve, reject) => store.get(id, (err, value) => err ? reject(err) : resolve(value)));
  for (let i = 0; i < 6; i++) { await set('id-' + i, { user: i }); await sleep(3); }
  await sleep(80);
  store.sweep();
  await sleep(80);
  assert.ok(fs.readdirSync(dir).filter(f => f.endsWith('.json')).length <= 3);
  assert.equal(await get('id-5'), null);
});
