// core.js -- every decision of the reader, without radio or screen.
//
// The same policy as ClientCore in teletext_client.py: pages accepted only
// from our channel and never from ourselves, requests rate-limited because
// each one spends shared airtime, navigation over the pages held.

import { PageRegistry, decode, INDEX_PAGE, pad3 } from "./teletext.js";

// The same page at most once a minute; any two requests 10 s apart.
export const REQUEST_EVERY_MS = 60_000;
export const REQUEST_GAP_MS = 10_000;

// Lines kept in the connection journal.
export const LOG_LINES = 50;

/**
 * Fires `onFire` once unless stopped within `ms`. The connection uses it to
 * say so when configuration never completes, instead of waiting forever.
 * Timers are injectable for tests.
 */
export class Watchdog {
  constructor(ms, onFire, timers = globalThis) {
    this.ms = ms;
    this.onFire = onFire;
    this.timers = timers;
    this.id = null;
  }

  start() {
    this.stop();
    this.id = this.timers.setTimeout(() => {
      this.id = null;
      this.onFire();
    }, this.ms);
  }

  stop() {
    if (this.id !== null) this.timers.clearTimeout(this.id);
    this.id = null;
  }

  get running() {
    return this.id !== null;
  }
}

export class ReaderCore {
  /**
   * @param {object} o
   * @param {number} [o.staleMinutes] age past which a page is re-requested
   * @param {() => number} [o.clock] monotonic milliseconds, paces requests
   * @param {() => Date} [o.now] wall time, ages pages
   */
  constructor({ staleMinutes = 45, clock, now } = {}) {
    this.staleMs = staleMinutes * 60_000;
    this.clock = clock ?? (() => performance.now());
    this.now = now ?? (() => new Date());
    this.registry = new PageRegistry();
    this.channelIndex = null; // unknown until the radio says
    this.me = null;
    this.current = INDEX_PAGE;
    this.typed = "";
    this.note = "";
    this.errors = []; // {time, text}, newest first
    this.log = []; // connection journal, oldest first, for the Journal panel
    this.asked = new Map(); // page -> clock of our last request
    this.askedAt = new Map(); // page -> Date, for display
    this.lastAsk = null;
  }

  // ------------------------------------------------------------- inbound

  /** A text message heard by the radio. Returns the page held, or null. */
  onText(channel, from, text) {
    if (this.channelIndex === null || channel !== this.channelIndex) return null;
    if (this.me !== null && from === this.me) return null;
    const page = decode(text, this.now());
    if (!page) return null;
    const held = this.registry.put(page);
    if (held === page) this.askedAt.delete(page.number);
    return held;
  }

  _time() {
    const t = this.now();
    return [t.getHours(), t.getMinutes(), t.getSeconds()]
      .map((n) => String(n).padStart(2, "0")).join(":");
  }

  /** One line of the connection journal, which the user can copy and send. */
  journal(text) {
    this.log.push(`${this._time()} ${text}`);
    if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES);
  }

  error(text) {
    const time = this._time();
    this.errors.unshift({ time, text: String(text) });
    this.errors.length = Math.min(this.errors.length, 20);
    this.journal(`ERREUR ${text}`);
  }

  // ------------------------------------------------------------ requests

  ageS(number) {
    return this.registry.ageS(number, this.now());
  }

  isStale(number) {
    const age = this.ageS(number);
    return age !== null && age * 1000 > this.staleMs;
  }

  /** Whether to ask for `number` now: {ok, why}. */
  wantRequest(number, force = false) {
    if (!Number.isInteger(number) || number < 0 || number > 999) {
      return { ok: false, why: `page ${number} impossible` };
    }
    if (this.channelIndex === null) {
      return { ok: false, why: "pas connecte au canal" };
    }
    const age = this.ageS(number);
    if (!force && age !== null && age * 1000 <= this.staleMs) {
      return { ok: false, why: `T${pad3(number)} est a jour` };
    }
    const clock = this.clock();
    const last = this.asked.get(number);
    if (last !== undefined && clock - last < REQUEST_EVERY_MS) {
      return {
        ok: false,
        why: `T${pad3(number)} deja demandee il y a ${Math.trunc((clock - last) / 1000)} s`,
      };
    }
    if (this.lastAsk !== null && clock - this.lastAsk < REQUEST_GAP_MS) {
      const wait = Math.ceil((REQUEST_GAP_MS - (clock - this.lastAsk)) / 1000);
      return { ok: false, why: `attendre ${wait} s avant une autre demande` };
    }
    return { ok: true, why: "" };
  }

  markRequested(number) {
    const clock = this.clock();
    this.asked.set(number, clock);
    this.lastAsk = clock;
    this.askedAt.set(number, this.now());
  }

  // ---------------------------------------------------------- navigation

  goto(number) {
    this.current = number;
    this.typed = "";
  }

  step(direction) {
    const held = this.registry.numbers();
    if (!held.length) return;
    if (direction > 0) {
      const later = held.filter((n) => n > this.current);
      this.goto(later.length ? later[0] : held[0]);
    } else {
      const earlier = held.filter((n) => n < this.current);
      this.goto(earlier.length ? earlier[earlier.length - 1] : held[held.length - 1]);
    }
  }

  /**
   * One digit typed. Returns the page number once three digits are in,
   * else null.
   */
  digit(d) {
    this.typed += String(d);
    if (this.typed.length < 3) return null;
    const number = Number(this.typed);
    this.goto(number);
    return number;
  }

  backspace() {
    this.typed = this.typed.slice(0, -1);
  }

  /** Whether arriving on `number` should trigger a request. */
  needsRequest(number) {
    return !this.registry.has(number) || this.isStale(number);
  }
}
