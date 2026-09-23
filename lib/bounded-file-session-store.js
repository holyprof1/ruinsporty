'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');

// A small, dependency-free persistent store for single-instance cPanel hosting.
// Session ids are hashed so user-controlled values can never become paths.
class BoundedFileSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.dir = options.dir;
    this.maxSessions = options.maxSessions || 500;
    this.ttlMs = options.ttlMs || 60 * 60 * 1000;
    this.sweepIntervalMs = options.sweepIntervalMs || 15 * 60 * 1000;
    this.sweeping = false;
    fs.mkdirSync(this.dir, { recursive: true });
    this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.timer.unref?.();
  }

  file(sid) {
    return path.join(this.dir, crypto.createHash('sha256').update(String(sid)).digest('hex') + '.json');
  }

  get(sid, callback) {
    fs.readFile(this.file(sid), 'utf8', (err, raw) => {
      if (err) return callback(err.code === 'ENOENT' ? null : err, null);
      try {
        const record = JSON.parse(raw);
        if (!record.expiresAt || record.expiresAt <= Date.now()) {
          return fs.unlink(this.file(sid), () => callback(null, null));
        }
        callback(null, record.session);
      } catch (parseErr) { callback(parseErr); }
    });
  }

  set(sid, value, callback = () => {}) {
    const cookieExpiry = value?.cookie?.expires ? new Date(value.cookie.expires).getTime() : 0;
    const expiresAt = Number.isFinite(cookieExpiry) && cookieExpiry > Date.now()
      ? cookieExpiry : Date.now() + this.ttlMs;
    const target = this.file(sid);
    const temp = `${target}.${process.pid}.tmp`;
    const body = JSON.stringify({ expiresAt, session: value });
    fs.writeFile(temp, body, { mode: 0o600 }, err => {
      if (err) return callback(err);
      fs.rename(temp, target, renameErr => {
        callback(renameErr || null);
        if (!renameErr) this.sweep();
      });
    });
  }

  destroy(sid, callback = () => {}) {
    fs.unlink(this.file(sid), err => callback(err && err.code !== 'ENOENT' ? err : null));
  }

  touch(sid, value, callback = () => {}) { this.set(sid, value, callback); }

  sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    fs.readdir(this.dir, { withFileTypes: true }, (err, entries = []) => {
      if (err) { this.sweeping = false; return; }
      const files = entries.filter(e => e.isFile() && e.name.endsWith('.json'));
      Promise.all(files.map(async entry => {
        const file = path.join(this.dir, entry.name);
        try { return { file, stat: await fs.promises.stat(file) }; } catch { return null; }
      })).then(items => {
        const now = Date.now();
        const sorted = items.filter(Boolean).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
        return Promise.all(sorted.map(async (item, index) => {
          if (index >= this.maxSessions || now - item.stat.mtimeMs > this.ttlMs) {
            try { await fs.promises.unlink(item.file); } catch {}
          }
        }));
      }).finally(() => { this.sweeping = false; });
    });
  }

  close() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

module.exports = BoundedFileSessionStore;
