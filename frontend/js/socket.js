// WebSocket client: connects using a short-lived single-use ticket obtained
// from the server, reconnects with exponential backoff, and sends a keep-alive
// ping so idle proxies don't drop the connection.
//
// Using a ticket instead of passing the long-lived Bearer token directly in the
// URL prevents the token from appearing in server access logs.

const PING_EVERY_MS = 25_000;
const CLOSE_UNAUTHORIZED = 4401;

export class LiveConnection {
  constructor({ getTicket, onEvent, onState, onReconnect, onAuthFailed }) {
    this.getTicket = getTicket;   // async fn() -> string
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
    this._open();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timers.ping);
    clearTimeout(this.timers.retry);
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    this.ws = null;
  }

  async _open() {
    this.onState("connecting");

    // Fetch a fresh single-use ticket right before opening the socket so it
    // has the maximum time to be redeemed before it expires (30 s).
    let ticket;
    try {
      const result = await this.getTicket();
      ticket = result.ticket;
    } catch {
      // If we can't get a ticket (e.g. session expired), treat it as auth failure.
      this.onAuthFailed();
      return;
    }

    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${window.location.host}/ws?ticket=${encodeURIComponent(ticket)}`);
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
      this.timers.retry = setTimeout(() => !this.stopped && this._open(), delay);
    };
  }
}
