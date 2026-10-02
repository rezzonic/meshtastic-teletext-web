// sirens.js -- drawings of the siren tones for pages 311 and 312.
//
// The drawings never travel over the radio: a page is 180 bytes and every
// byte costs shared airtime. The server puts a signature in plain characters
// on the page's second line, which the Meshtastic app and the T-Echo show as
// is; the reader recognises it word for word and draws the tone in its place
// (PROTOCOL.md, "Pages des sirènes"). No signature -- an older server -- and
// the page is simply shown as text.
//
// Pure functions returning SVG markup, so they are tested without a DOM.

export const SIGNATURES = {
  311: { kind: "general", line: "Son: /\\/\\/\\/\\/\\/\\ 1 min" },
  312: { kind: "water", line: "Son: __ __ __ __ __ x12" },
};

/**
 * The drawing a page calls for, and its body without the signature line.
 * Returns { kind: "general" | "water" | null, body }.
 */
export function splitSignature(page) {
  const sig = SIGNATURES[page?.number];
  const lines = String(page?.body ?? "").split("\n");
  if (!sig || lines[1] !== sig.line) return { kind: null, body: page?.body ?? "" };
  lines.splice(1, 1);
  return { kind: sig.kind, body: lines.join("\n") };
}

// Drawing area, in SVG units; the element scales to the screen width.
const W = 340;
const H = 120;
const LEFT = 16;
const RIGHT = W - 14;

const f = (n) => Number(n.toFixed(1));

function text(x, y, label, cls, anchor = "middle") {
  return `<text x="${f(x)}" y="${f(y)}" class="${cls}" text-anchor="${anchor}">${label}</text>`;
}

/** A horizontal span marker: a line with end ticks, and its label below. */
function span(x1, x2, y, label, cls) {
  return `<path d="M${f(x1)},${y - 4}V${y + 4}M${f(x1)},${y}H${f(x2)}M${f(x2)},${y - 4}V${y + 4}" class="${cls}-line"/>`
    + text((x1 + x2) / 2, y + 16, label, cls);
}

/** General alarm: the pitch rises and falls for 1 min, 5 min of silence,
 * again for 1 min. The oscillation count is symbolic. */
function general() {
  const block = 120;
  const second = RIGHT - block;
  const wave = (x0) => {
    let d = "";
    for (let i = 0; i <= 200; i += 1) {
      const x = x0 + (block * i) / 200;
      const y = 50 - 22 * Math.sin((i / 200) * 2 * Math.PI * 7);
      d += `${i ? "L" : "M"}${f(x)},${f(y)}`;
    }
    return `<path d="${d}" class="siren-wave"/>`;
  };
  return [
    text(LEFT, 14, "hauteur du son", "siren-axis", "start"),
    `<path d="M${LEFT},78H${RIGHT}" class="siren-base"/>`,
    wave(LEFT),
    wave(second),
    span(LEFT, LEFT + block, 92, "1 min", "siren-on"),
    span(LEFT + block + 6, second - 6, 92, "5 min", "siren-off"),
    span(second, RIGHT, 92, "1 min", "siren-on"),
  ];
}

/** Water alarm: 12 low tones of 20 s, 10 s apart, to scale (about 6 min). */
function water() {
  const total = 12 * 20 + 11 * 10;
  const unit = (RIGHT - LEFT) / total;
  const bars = [];
  for (let i = 0; i < 12; i += 1) {
    const x = LEFT + i * 30 * unit;
    bars.push(`<rect x="${f(x)}" y="46" width="${f(20 * unit)}" height="16" rx="2" class="siren-tone"/>`);
  }
  const gapStart = LEFT + 20 * unit;
  return [
    text(LEFT, 14, "son grave", "siren-axis", "start"),
    // "20 s" over the first tone, "10 s" under the first pause: kept apart.
    `<path d="M${f(LEFT)},40H${f(gapStart)}" class="siren-on-line"/>`,
    text(LEFT, 34, "20 s", "siren-on", "start"),
    ...bars,
    `<path d="M${f(gapStart)},68V74H${f(gapStart + 10 * unit)}V68" class="siren-off-line"/>`,
    text(gapStart, 86, "10 s", "siren-off", "start"),
    span(LEFT, RIGHT, 96, "12 sons, environ 6 min", "siren-on"),
  ];
}

const LABELS = {
  general: "Son de l'alarme generale : un son qui monte et descend pendant 1 minute, "
    + "5 minutes de pause, puis de nouveau 1 minute.",
  water: "Son de l'alarme-eau : 12 sons graves de 20 secondes, separes de 10 secondes.",
};

/** SVG markup for `kind`, or "" for anything else. */
export function sirenSvg(kind) {
  const parts = kind === "general" ? general() : kind === "water" ? water() : null;
  if (!parts) return "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="siren" `
    + `role="img" aria-label="${LABELS[kind]}">${parts.join("")}</svg>`;
}
