'use strict';

// Tiny in-memory sliding-window limiter. State is lost on restart and is not
// shared between processes (a single instance is assumed).

function createRateLimiter({ max, windowMs, now = Date.now, maxKeys = 20000 }) {
  const hits = new Map(); // key -> number[] (timestamps, ms)

  function prune(list, t) {
    while (list.length && t - list[0] >= windowMs) list.shift();
  }

  function sweep(t) {
    for (const [k, list] of hits) {
      prune(list, t);
      if (list.length === 0) hits.delete(k);
    }
  }

  return {
    /** Records an attempt. Returns {allowed, retryAfterSec}. */
    hit(key) {
      const t = now();
      let list = hits.get(key);
      if (!list) {
        if (hits.size >= maxKeys) {
          sweep(t);
          while (hits.size >= maxKeys) hits.delete(hits.keys().next().value); // evict oldest
        }
        list = [];
        hits.set(key, list);
      } else {
        prune(list, t);
      }
      if (list.length >= max) {
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000)) };
      }
      list.push(t);
      return { allowed: true, retryAfterSec: 0 };
    },
    /** Non-recording check. */
    peek(key) {
      const t = now();
      const list = hits.get(key);
      if (!list) return { allowed: true, retryAfterSec: 0 };
      prune(list, t);
      if (list.length >= max) {
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000)) };
      }
      return { allowed: true, retryAfterSec: 0 };
    },
    size: () => hits.size,
  };
}

module.exports = { createRateLimiter };
