// ReaderCore: the same behaviour as ClientCore in the terminal client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReaderCore } from "../src/core.js";

const T0 = new Date(2026, 8, 26, 14, 40);
const ME = 0x1234;

function wire(number, body = "corps", produced = T0) {
  const p = (n) => String(n).padStart(2, "0");
  return `T${String(number).padStart(3, "0")} 1/1 ${p(produced.getHours())}:${p(produced.getMinutes())}\n${body}`;
}

function reader(staleMinutes = 45) {
  const time = { clock: 1_000_000, now: new Date(T0) };
  const core = new ReaderCore({
    staleMinutes, clock: () => time.clock, now: () => time.now,
  });
  core.channelIndex = 2;
  core.me = ME;
  return { core, time };
}

test("stores pages from our channel only, never our own", () => {
  const { core } = reader();
  assert.equal(core.onText(2, 9, wire(101, "METEO")).body, "METEO");
  assert.equal(core.onText(0, 9, wire(201)), null);
  assert.equal(core.onText(1, 9, wire(201)), null);
  assert.equal(core.onText(2, ME, wire(201)), null);
  assert.equal(core.onText(2, 9, "salut"), null);
  assert.equal(core.onText(2, 9, "?301"), null);
  assert.deepEqual(core.registry.numbers(), [101]);
});

test("nothing is accepted before the channel is known", () => {
  const core = new ReaderCore();
  assert.equal(core.onText(0, 9, wire(101)), null);
  assert.equal(core.wantRequest(101).ok, false);
});

test("request policy", () => {
  const { core, time } = reader();
  assert.deepEqual(core.wantRequest(310), { ok: true, why: "" });
  core.onText(2, 9, wire(101));
  assert.match(core.wantRequest(101).why, /a jour/);
  assert.equal(core.wantRequest(101, true).ok, true);

  core.markRequested(310);
  time.clock += 4_000;
  assert.match(core.wantRequest(401).why, /attendre 6 s/);
  time.clock += 26_000;
  assert.match(core.wantRequest(310).why, /deja demandee il y a 30 s/);
  time.clock += 31_000;
  assert.equal(core.wantRequest(310).ok, true);
  assert.equal(core.wantRequest(1000).ok, false);
});

test("stale pages are requested again", () => {
  const { core, time } = reader(45);
  core.onText(2, 9, wire(101));
  assert.equal(core.needsRequest(101), false);
  time.now = new Date(T0.getTime() + 46 * 60_000);
  assert.equal(core.isStale(101), true);
  assert.equal(core.needsRequest(101), true);
  assert.equal(core.needsRequest(999), true);
});

test("an arriving page clears its pending request", () => {
  const { core } = reader();
  core.markRequested(310);
  assert.ok(core.askedAt.has(310));
  core.onText(2, 9, wire(310));
  assert.ok(!core.askedAt.has(310));
});

test("navigation", () => {
  const { core } = reader();
  for (const n of [100, 101, 201, 301]) core.onText(2, 9, wire(n));
  assert.equal(core.digit(3), null);
  assert.equal(core.digit(1), null);
  core.backspace();
  assert.equal(core.typed, "3");
  core.digit(1);
  assert.equal(core.digit(0), 310);
  assert.equal(core.current, 310);
  assert.equal(core.typed, "");
  core.step(-1);
  assert.equal(core.current, 301);
  core.step(+1);
  assert.equal(core.current, 100); // wraps
  core.step(-1);
  assert.equal(core.current, 301); // wraps back
});

test("errors are kept, newest first, bounded", () => {
  const { core } = reader();
  for (let i = 0; i < 30; i++) core.error(`e${i}`);
  assert.equal(core.errors.length, 20);
  assert.equal(core.errors[0].text, "e29");
  assert.equal(core.errors[0].time, "14:40:00");
});
