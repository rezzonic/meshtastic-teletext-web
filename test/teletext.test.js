// The JavaScript format against the contract generated from the Python code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decode, parseRequest, encodeRequest, formatAge, agoFr, PageRegistry,
} from "../src/teletext.js";

const vectors = JSON.parse(
  readFileSync(new URL("./wire_vectors.json", import.meta.url), "utf8"));

function localIso(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
    + `T${p(date.getHours())}:${p(date.getMinutes())}`;
}

test("decode agrees with teletext.py on every vector", () => {
  assert.ok(vectors.decode.length > 20);
  for (const v of vectors.decode) {
    const got = decode(v.text, new Date(v.now));
    if (v.page === null) {
      assert.equal(got, null, JSON.stringify(v.text));
    } else {
      assert.ok(got, JSON.stringify(v.text));
      assert.deepEqual(
        { ...got, produced: localIso(got.produced),
          source: got.source && localIso(got.source) },
        v.page, JSON.stringify(v.text));
    }
  }
});

test("requests agree with teletext.py", () => {
  for (const v of vectors.requests) {
    assert.equal(parseRequest(v.text), v.number, JSON.stringify(v.text));
  }
  for (const v of vectors.encode_request) {
    assert.equal(encodeRequest(v.number), v.text);
  }
  assert.throws(() => encodeRequest(1000), RangeError);
});

test("ages agree with teletext.py", () => {
  for (const v of vectors.format_age) {
    assert.equal(formatAge(v.seconds), v.text, String(v.seconds));
  }
});

test("decode never throws", () => {
  for (const junk of [null, undefined, 42, {}, [], "T101 1/1 12:00\n\u0000",
    "T101 99999999999999999999/1 12:00"]) {
    const got = decode(junk);
    assert.ok(got === null || typeof got === "object");
  }
});

test("agoFr matches the terminal client", () => {
  assert.equal(agoFr(10), "moins d'une minute");
  assert.equal(agoFr(12 * 60), "12 min");
  assert.equal(agoFr(3 * 3600 + 5 * 60), "3 h 05");
  assert.equal(agoFr(3 * 86400), "3 j");
});

const T0 = new Date(2026, 8, 26, 14, 40);
const page = (number, body, produced = T0) => ({ number, part: 1, total: 1, produced, body });

test("registry: replace, keep newer, bound, age", () => {
  const reg = new PageRegistry(3);
  reg.put(page(101, "vieux"));
  reg.put(page(101, "neuf", new Date(T0.getTime() + 60_000)));
  assert.equal(reg.put(page(101, "tardif")).body, "neuf");
  reg.put(page(102, ""));
  reg.put(page(103, ""));
  reg.put(page(104, ""));
  assert.deepEqual(reg.numbers(), [102, 103, 104]);
  assert.equal(reg.ageS(103, new Date(T0.getTime() + 90_000)), 90);
  assert.equal(reg.ageS(103, new Date(T0.getTime() - 60_000)), 0);
  assert.equal(reg.ageS(999), null);
});

test("registry survives a round trip through storage", () => {
  const reg = new PageRegistry();
  reg.put(page(101, "METEO\nAuj"));
  reg.put(page(310, "SIRENES"));
  const copy = new PageRegistry();
  copy.load(JSON.parse(JSON.stringify(reg.toJSON())));
  assert.deepEqual(copy.numbers(), [101, 310]);
  assert.equal(copy.get(101).body, "METEO\nAuj");
  assert.equal(copy.get(101).produced.getTime(), T0.getTime());
  copy.load([null, { number: "x" }, { number: 5, body: 3 }]);
  copy.load("garbage");
  assert.equal(copy.size, 2);
});

test("the cache keeps the source time, the failed mark and the reception", () => {
  const reg = new PageRegistry();
  const page = decode("T201 1/1 14:40 s14:20 !\nACTU", new Date(2026, 8, 26, 14, 41));
  page.received = new Date(2026, 8, 26, 14, 41, 5);
  reg.put(page);
  const copy = new PageRegistry();
  copy.load(JSON.parse(JSON.stringify(reg.toJSON())));
  const got = copy.get(201);
  assert.equal(got.source.getTime(), new Date(2026, 8, 26, 14, 20).getTime());
  assert.equal(got.failing, true);
  assert.equal(got.received.getTime(), page.received.getTime());
  // A cache written by an older version has none of them.
  copy.load([{ number: 101, produced: Date.now(), body: "x" }]);
  assert.equal(copy.get(101).source, null);
  assert.equal(copy.get(101).failing, false);
});
