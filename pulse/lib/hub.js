// In-memory SSE pub/sub. One process, fans out to all connected clients of
// a given key (channel_id or dm_id). Survives a satellite restart with no
// data — clients reconnect via EventSource's built-in retry and re-fetch
// any history they missed.

class Hub {
  constructor() {
    this.rooms = new Map(); // key -> Set<res>
  }

  subscribe(key, res) {
    let set = this.rooms.get(key);
    if (!set) { set = new Set(); this.rooms.set(key, set); }
    set.add(res);
    return () => {
      const s = this.rooms.get(key);
      if (!s) return;
      s.delete(res);
      if (s.size === 0) this.rooms.delete(key);
    };
  }

  publish(key, event) {
    const set = this.rooms.get(key);
    if (!set) return;
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of set) {
      try { res.write(data); } catch { /* dead socket — close handler will clean up */ }
    }
  }

  size() {
    let n = 0;
    for (const s of this.rooms.values()) n += s.size;
    return n;
  }
}

module.exports = new Hub();
