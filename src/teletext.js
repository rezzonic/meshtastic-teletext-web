// teletext.js -- the page format, ported from teletext.py.
//
// This is the only logic duplicated between the two repositories, so it is
// held to the same contract: test/wire_vectors.json, generated from the
// Python code, is replayed by test/teletext.test.js. When the format
// changes there, copy the file again; a disagreement then fails a test.
//
// Times are local Date objects throughout. The header carries only hh:mm,
// so server and reader are assumed to share a time zone.

// T<number> <part>/<total> <hh:mm>[ s<hh:mm>][ !]: generated at, the
// source's own time, and "!" when the last update failed (PROTOCOL.md).
export const HEADER = /^T(\d{3}) (\d+)\/(\d+) (\d{2}:\d{2})(?: s(\d{2}:\d{2}))?( !)?\s*$/;
export const REQUEST = /^\?(\d{3})\s*$/;

export const CHANNEL_NAME = "TXT";
// Requests travel up to 3 hops, the server's ceiling; it answers with the
// distance the request actually travelled (PROTOCOL.md, hop_limit).
export const HOP_LIMIT = 3;
export const INDEX_PAGE = 100;

// A header up to this far ahead of our clock is clock skew, not yesterday.
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export const PAGE_TITLES = {
  100: "INDEX",
  101: "METEO",
  201: "ACTUALITES",
  301: "ALERTES",
  310: "SIRENES",
  311: "ALARME GENERALE",
  312: "ALARME EAU",
  313: "SIRENES INFOS",
  401: "ETAT DU MAILLAGE",
};

/** The latest moment at "hh:mm" not after `limit`, or null if invalid. */
function atOrBefore(text, limit) {
  const [hh, mm] = text.split(":").map(Number);
  if (hh > 23 || mm > 59) return null;
  let when = new Date(limit.getFullYear(), limit.getMonth(), limit.getDate(), hh, mm);
  if (when.getTime() > limit.getTime()) {
    when = new Date(when.getFullYear(), when.getMonth(), when.getDate() - 1, hh, mm);
  }
  return when;
}

function toMinute(date) {
  const d = new Date(date.getTime());
  d.setSeconds(0, 0);
  return d;
}

/**
 * Parse received text into a page, or null if it is not one.
 * Never throws: it is fed every text message the radio hears.
 */
export function decode(text, now = new Date()) {
  try {
    if (typeof text !== "string") return null;
    const cut = text.indexOf("\n");
    const head = cut < 0 ? text : text.slice(0, cut);
    let body = cut < 0 ? "" : text.slice(cut + 1);
    const m = HEADER.exec(head);
    if (!m) return null;
    const number = Number(m[1]);
    const part = Number(m[2]);
    const total = Number(m[3]);
    if (!(part >= 1 && part <= total)) return null;
    const [hh, mm] = m[4].split(":").map(Number);
    if (hh > 23 || mm > 59) return null;

    const nowMin = toMinute(now);
    let produced = new Date(nowMin.getFullYear(), nowMin.getMonth(),
      nowMin.getDate(), hh, mm);
    if (produced.getTime() > nowMin.getTime() + CLOCK_SKEW_MS) {
      produced = new Date(produced.getFullYear(), produced.getMonth(),
        produced.getDate() - 1, hh, mm);
    }
    const source = m[5] === undefined ? null : atOrBefore(m[5], produced);
    if (m[5] !== undefined && source === null) return null;
    body = body.replace(/\r\n/g, "\n").replace(/\s+$/, "");
    return { number, part, total, produced, source, failing: m[6] !== undefined, body };
  } catch {
    return null;
  }
}

/** Page number from a request such as "?301", else null. */
export function parseRequest(text) {
  if (typeof text !== "string") return null;
  const m = REQUEST.exec(text.trim());
  return m ? Number(m[1]) : null;
}

/** Wire text of a request for page `number`: "?301". */
export function encodeRequest(number) {
  if (!Number.isInteger(number) || number < 0 || number > 999) {
    throw new RangeError(`page number must have three digits: ${number}`);
  }
  return `?${String(number).padStart(3, "0")}`;
}

/** Compact age: "-" / "45s" / "12m" / "3h" / "2j". */
export function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return "-";
  const s = Math.max(Math.trunc(seconds), 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}j`;
}

/** "il y a ..." wording, as in the terminal client. */
export function agoFr(seconds) {
  const s = Math.max(Math.trunc(seconds), 0);
  if (s < 60) return "moins d'une minute";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) {
    return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  }
  return `${Math.floor(s / 86400)} j`;
}

export function pad3(n) {
  return String(n).padStart(3, "0");
}

export function hhmm(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * The reader's cache: a page per number, bounded, and never overwritten by a
 * late rebroadcast of an older version.
 */
export class PageRegistry {
  constructor(maxPages = 64) {
    this.maxPages = maxPages;
    this.pages = new Map(); // number -> page, least recently stored first
  }

  get size() {
    return this.pages.size;
  }

  /** Store a page; returns the page now held. */
  put(page) {
    const held = this.pages.get(page.number);
    if (held && page.produced.getTime() < held.produced.getTime()) return held;
    this.pages.delete(page.number);
    this.pages.set(page.number, page);
    while (this.pages.size > this.maxPages) {
      this.pages.delete(this.pages.keys().next().value);
    }
    return page;
  }

  get(number) {
    return this.pages.get(number) ?? null;
  }

  has(number) {
    return this.pages.has(number);
  }

  /** Seconds since that page was produced, or null if absent. */
  ageS(number, now = new Date()) {
    const page = this.pages.get(number);
    if (!page) return null;
    return Math.max((now.getTime() - page.produced.getTime()) / 1000, 0);
  }

  numbers() {
    return [...this.pages.keys()].sort((a, b) => a - b);
  }

  /** Pages as plain data, for storage. */
  toJSON() {
    return [...this.pages.values()].map((p) => ({
      number: p.number, part: p.part, total: p.total,
      produced: p.produced.getTime(), body: p.body,
      source: p.source ? p.source.getTime() : null,
      failing: Boolean(p.failing),
      received: p.received ? p.received.getTime() : null,
    }));
  }

  /** Restore what toJSON() produced; skips anything malformed. */
  load(items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || !Number.isInteger(item.number) || typeof item.body !== "string"
          || !Number.isFinite(item.produced)) continue;
      this.put({
        number: item.number, part: item.part || 1, total: item.total || 1,
        produced: new Date(item.produced), body: item.body,
        source: Number.isFinite(item.source) ? new Date(item.source) : null,
        failing: item.failing === true,
        received: Number.isFinite(item.received) ? new Date(item.received) : null,
      });
    }
  }
}
