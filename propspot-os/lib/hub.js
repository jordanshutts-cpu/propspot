// In-memory SSE pub/sub. One process, fans out to all connected clients of
// a given key. Survives a satellite restart with no data — clients reconnect
// via EventSource's built-in retry and re-fetch any history they missed.
//
// Keys used:
//   channel:<uuid>  — broadcast to all members reading a channel
//   dm:<uuid>       — broadcast to all members of a DM
//   user:<uuid>     — broadcast to a single user across all their tabs
//                     (used for unread_update and mention events that
//                      cross the currently-open scope)
//
// One SSE connection can subscribe to multiple keys at once — when the user
// opens a channel, their connection joins both `channel:<id>` and
// `user:<userId>` rooms simultaneously.

class Hub {
  constructor() {
    this.rooms = new Map(); // key -> Set<res>
  }

  // subscribe(key, res) OR subscribe([key1, key2], res)
  // Returns a single unsubscribe function that removes the res from all rooms.
  subscribe(keyOrKeys, res) {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    for (const key of keys) {
      let set = this.rooms.get(key);
      if (!set) { set = new Set(); this.rooms.set(key, set); }
      set.add(res);
    }
    return () => {
      for (const key of keys) {
        const s = this.rooms.get(key);
        if (!s) continue;
        s.delete(res);
        if (s.size === 0) this.rooms.delete(key);
      }
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
