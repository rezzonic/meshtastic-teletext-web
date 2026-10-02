// The siren drawings: signature detection and the drawings' geometry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SIGNATURES, splitSignature, sirenSvg } from "../src/sirens.js";

const GENERAL = "ALARME GENERALE\nSon: /\\/\\/\\/\\/\\/\\ 1 min\n"
  + "Son oscillant continu 1 min, repete apres 5 min.\n- Allumer la radio";
const WATER = "ALARME EAU\nSon: __ __ __ __ __ x12\n12 sons graves de 20 s, pauses de 10 s.";

const page = (number, body) => ({ number, part: 1, total: 1, produced: new Date(), body });

test("signatures are exactly those the server sends (PROTOCOL.md)", () => {
  assert.equal(SIGNATURES[311].line, "Son: /\\/\\/\\/\\/\\/\\ 1 min");
  assert.equal(SIGNATURES[312].line, "Son: __ __ __ __ __ x12");
});

test("the signature line is found and taken out of the text", () => {
  assert.deepEqual(splitSignature(page(311, GENERAL)), {
    kind: "general",
    body: "ALARME GENERALE\nSon oscillant continu 1 min, repete apres 5 min.\n- Allumer la radio",
  });
  assert.deepEqual(splitSignature(page(312, WATER)), {
    kind: "water",
    body: "ALARME EAU\n12 sons graves de 20 s, pauses de 10 s.",
  });
});

test("no drawing without the exact signature, on its line, on its page", () => {
  for (const p of [
    page(311, "ALARME GENERALE\nSon oscillant continu"), // older server
    page(312, GENERAL),                                   // wrong page
    page(310, GENERAL),                                   // not a siren page
    page(311, "ALARME\nx\nSon: /\\/\\/\\/\\/\\/\\ 1 min"),   // wrong line
    page(312, "ALARME EAU\nSon: == == == == x12"),        // old signature
  ]) {
    const got = splitSignature(p);
    assert.equal(got.kind, null);
    assert.equal(got.body, p.body);
  }
  assert.equal(splitSignature(null).kind, null);
});

function count(svg, tag) {
  return (svg.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;
}

test("general alarm: two one-minute waves around a five-minute pause", () => {
  const svg = sirenSvg("general");
  assert.equal(count(svg, "path") - 1 - 3, 2, "two waves besides the base and three spans");
  assert.equal((svg.match(/class="siren-wave"/g) ?? []).length, 2);
  assert.match(svg, />1 min</);
  assert.match(svg, />5 min</);
  assert.match(svg, /role="img" aria-label="Son de l'alarme generale/);
});

test("water alarm: twelve tones of 20 s with 10 s pauses, to scale", () => {
  const svg = sirenSvg("water");
  const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="46" width="([\d.]+)"/g)]
    .map((m) => [Number(m[1]), Number(m[2])]);
  assert.equal(rects.length, 12);
  const [x0, w] = rects[0];
  const step = rects[1][0] - x0;
  assert.ok(Math.abs(step / w - 30 / 20) < 0.02, "tone 20 s, period 30 s");
  for (let i = 1; i < 12; i++) {
    assert.ok(Math.abs(rects[i][0] - rects[i - 1][0] - step) < 0.2, `even spacing at ${i}`);
  }
  // The two labels sit on different rows, so they cannot overlap.
  const y20 = Number(svg.match(/y="([\d.]+)"[^>]*>20 s</)[1]);
  const y10 = Number(svg.match(/y="([\d.]+)"[^>]*>10 s</)[1]);
  assert.ok(Math.abs(y20 - y10) >= 20, `labels apart: ${y20} / ${y10}`);
});

test("drawings stay inside their box", () => {
  for (const kind of ["general", "water"]) {
    const svg = sirenSvg(kind);
    for (const m of svg.matchAll(/\b(?:x|x1|x2)="([\d.-]+)"/g)) {
      assert.ok(Number(m[1]) >= 0 && Number(m[1]) <= 340, `${kind} x ${m[1]}`);
    }
    for (const m of svg.matchAll(/[ML]([\d.-]+),([\d.-]+)/g)) {
      assert.ok(Number(m[1]) >= 0 && Number(m[1]) <= 340, `${kind} path x ${m[1]}`);
      assert.ok(Number(m[2]) >= 0 && Number(m[2]) <= 120, `${kind} path y ${m[2]}`);
    }
  }
  assert.equal(sirenSvg("other"), "");
});
