'use strict';

class Semaphore {
  constructor(limit, maxQueue = limit * 4) {
    this.limit = limit;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.queue = [];
  }
  acquire() {
    if (this.active < this.limit) { this.active++; return Promise.resolve(this.releaseFn()); }
    if (this.queue.length >= this.maxQueue) return Promise.reject(Object.assign(new Error('Server busy'), { code: 'QUEUE_FULL' }));
    return new Promise(resolve => this.queue.push(resolve));
  }
  releaseFn() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next(this.releaseFn()); else this.active--;
    };
  }
}

function semaphoreMiddleware(semaphore) {
  return async (req, res, next) => {
    let release;
    try { release = await semaphore.acquire(); }
    catch { return res.status(503).set('Retry-After', '2').json({ error: 'Server busy; retry shortly' }); }
    let done = false;
    const finish = () => { if (!done) { done = true; release(); } };
    res.once('finish', finish);
    res.once('close', finish);
    next();
  };
}

function startNonOverlappingJob(fn, intervalMs, options = {}) {
  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped) return false;
    running = true;
    try { await fn(); } catch (err) { options.onError?.(err); }
    finally { running = false; }
    return true;
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  if (options.runImmediately) void run();
  return { run, stop() { stopped = true; clearInterval(timer); }, get running() { return running; } };
}

module.exports = { Semaphore, semaphoreMiddleware, startNonOverlappingJob };
