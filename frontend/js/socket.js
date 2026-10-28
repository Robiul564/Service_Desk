// WebSocket client: connects with the session token, reconnects with backoff,
// and sends a keep-alive ping so idle proxies don't drop the connection.

const PING_EVERY_MS = 25_000;
const CLOSE_UNAUTHORIZED = 4401;

export class LiveConnection {
  constructor({ getToken, onEvent, onState, onReconnect, onAuthFailed }) {
    this.getToken = getToken;
    this.onEvent = onEvent;
    this.onState = onState;
    this.onReconnect = onReconnect;
    this.onAuthFailed = onAuthFailed;
    this.ws = null;
    this.attempt = 0;
    this.stopped = true;
    this.hasConnectedBefore = false;
    this.timers = { ping: null, retry: null };
  }

  start() {
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timers.ping);
    clearTimeout(this.timers.retry);
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    this.ws = null;
  }

  open() {
    this.onState("connecting");
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${window.location.host}/ws?token=${encodeURIComponent(this.getToken())}`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.onState("live");
      // Anything that happened while we were disconnected was never pushed to us.
      if (this.hasConnectedBefore) this.onReconnect();
      this.hasConnectedBefore = true;
      clearInterval(this.timers.ping);
      this.timers.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), PING_EVERY_MS);
    };

    ws.onmessage = (event) => {
      try { this.onEvent(JSON.parse(event.data)); } catch (err) { console.error("Bad WebSocket message", err); }
    };

    ws.onclose = (event) => {
      clearInterval(this.timers.ping);
      if (this.stopped) return;
      if (event.code === CLOSE_UNAUTHORIZED) { this.onAuthFailed(); return; }
      this.onState("offline");
      const delay = Math.min(15_000, 1000 * 2 ** this.attempt++);
      this.timers.retry = setTimeout(() => !this.stopped && this.open(), delay);
    };
  }
}
