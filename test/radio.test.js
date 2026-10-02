// Radio against a simulated T-Echo: the real @meshtastic/core and the real
// Web Bluetooth transport, talking protobuf to a fake GATT server. What this
// cannot know is how a real phone and firmware time things; it does check
// the protocol, the journal, the watchdog and the request packet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Constants } from "@meshtastic/core";
import { ReaderCore } from "../src/core.js";
import { Radio } from "../src/radio.js";
import { fakeTEcho, wait, ME } from "./fake-techo.js";

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await wait(10);
  }
  return check();
}

function setup(echo, silenceMs = 400) {
  const core = new ReaderCore();
  const radio = new Radio(core, { channelName: "TXT", onChange: () => {}, silenceMs });
  radio.btDevice = echo.device;
  return { core, radio };
}

test("connects, asks for configuration only, finds TXT, receives a page", async (t) => {
  const echo = fakeTEcho({ nodes: 300 });
  const { core, radio } = setup(echo);
  t.after(() => radio.disconnect());
  await radio.connect();
  assert.ok(await until(() => radio.status === "pret"), core.log.join("\n"));
  const want = echo.written.find((m) => m.payloadVariant.case === "wantConfigId");
  assert.equal(want.payloadVariant.value, 69420);
  assert.equal(core.channelIndex, 2);
  assert.equal(core.me, ME);
  assert.ok(core.log.some((l) => l.includes("firmware 2.7.9")), core.log.join("\n"));
  assert.ok(core.log.some((l) => l.includes("configuration recue: 0 fiches de noeuds")));

  echo.hear("T101 1/1 14:40\nMETEO TEST");
  echo.hear("T201 1/1 14:40\nsur le canal public", 0);
  assert.ok(await until(() => core.registry.has(101)));
  await wait(50);
  assert.deepEqual(core.registry.numbers(), [101]);
  assert.ok(core.log.some((l) => l.endsWith("T101 recue")));
});

test("a long node download is not cut off while it progresses", async (t) => {
  // Firmware that ignores the nonce: 300 node records, one every 5 ms, well
  // past the 400 ms silence limit in total but never silent for long.
  const echo = fakeTEcho({ nodes: 300, honourNonce: false, stepMs: 5 });
  const { core, radio } = setup(echo);
  t.after(() => radio.disconnect());
  await radio.connect();
  assert.ok(await until(() => radio.status === "pret", 10_000), core.log.join("\n"));
  assert.equal(core.errors.length, 0, core.log.join("\n"));
  assert.ok(core.log.some((l) => l.includes("300 fiches de noeuds recues")));
  assert.equal(core.channelIndex, 2);
});

test("without notifications, polling still reads the configuration and pages", async (t) => {
  // The first real run: one item read right after want_config, the next read
  // empty because the device was not ready, and no notification ever after.
  const echo = fakeTEcho({ notify: false, stepMs: 20 });
  const { core, radio } = setup(echo, 2000);
  t.after(() => radio.disconnect());
  await radio.connect();
  assert.ok(await until(() => radio.status === "pret", 5000), core.log.join("\n"));
  assert.equal(core.channelIndex, 2);
  assert.ok(core.log.some((l) => /lectures \d+ \(dont \d+ vides, tailles .*\), notifications 0/.test(l)),
    core.log.join("\n"));
  echo.hear("T301 1/1 14:40\nALERTES");
  assert.ok(await until(() => core.registry.has(301), 3000), "page read by the idle poll");
});

test("never two Bluetooth operations at once", async (t) => {
  // The third real run: the want_config write collided with enabling
  // notifications and a poll read, failed, and nothing was ever asked.
  const echo = fakeTEcho({ nodes: 50, honourNonce: false, notify: false });
  const { core, radio } = setup(echo, 2000);
  t.after(() => radio.disconnect());
  await radio.connect();
  assert.ok(await until(() => radio.status === "pret", 8000), core.log.join("\n"));
  await radio.sendRequest(310);
  assert.ok(await until(() => echo.written.some((m) => m.payloadVariant.case === "packet")));
  assert.deepEqual(echo.collisions, []);
  assert.ok(!core.log.some((l) => l.includes("ERREUR GATT")), core.log.join("\n"));
});

test("in a browser, a library warning no longer kills the decoding", async (t) => {
  // The fourth real run: identity, then 67 reads never understood. The
  // bundled logger calls Buffer.isBuffer on every warning, and a browser has
  // no Buffer; deviceuiConfig, right after the identity, triggers a warning.
  const saved = globalThis.Buffer;
  delete globalThis.Buffer;
  t.after(() => { globalThis.Buffer = saved; });
  const echo = fakeTEcho({ notify: false });
  const { core, radio } = setup(echo, 2000);
  t.after(() => radio.disconnect());
  await radio.connect();
  assert.ok(await until(() => radio.status === "pret", 5000), core.log.join("\n"));
  assert.equal(core.channelIndex, 2);
  assert.ok(core.log.some((l) => /biblio: .*deviceuiConfig/.test(l)), core.log.join("\n"));
  assert.ok(core.log.some((l) => /elements recus: .*deviceuiConfig 1/.test(l)), core.log.join("\n"));
  assert.ok(!core.log.some((l) => l.includes("lecture illisible")), core.log.join("\n"));
});

test("unreadable reads are shown as hex", async (t) => {
  const echo = fakeTEcho({ garbleAfter: 1 });
  const { core, radio } = setup(echo, 500);
  t.after(() => radio.disconnect());
  await radio.connect();
  assert.ok(await until(() => core.errors.length > 0, 4000), core.log.join("\n"));
  const hex = core.log.filter((l) => l.includes("lecture illisible"));
  assert.ok(hex.length >= 1 && hex.length <= 3, core.log.join("\n"));
  assert.match(hex[0], /lecture illisible \(\d+ o\): [0-9a-f]+ -- /);
  assert.ok(core.log.some((l) => /tailles \d+\.\.\d+ octets/.test(l)), core.log.join("\n"));
});

test("a T-Echo that goes silent is reported and released", async () => {
  const echo = fakeTEcho({ stallAfter: 1 });
  const { core, radio } = setup(echo, 300);
  await radio.connect();
  assert.ok(await until(() => core.errors.length > 0, 3000), core.log.join("\n"));
  assert.match(core.errors[0].text, /n'envoie plus rien/);
  assert.equal(radio.status, "deconnecte");
  assert.equal(radio.transport, null);
});

test("a request goes out on TXT with hop limit 3, without waiting for an ack", async (t) => {
  const echo = fakeTEcho();
  const { core, radio } = setup(echo);
  t.after(() => radio.disconnect());
  await radio.connect();
  assert.ok(await until(() => radio.status === "pret"));
  const started = Date.now();
  await radio.sendRequest(310);
  assert.ok(Date.now() - started < 1000, "sendRequest must not wait for an ack");
  assert.ok(await until(() => echo.written.some((m) => m.payloadVariant.case === "packet")));
  const packet = echo.written.find((m) => m.payloadVariant.case === "packet").payloadVariant.value;
  assert.equal(packet.channel, 2);
  assert.equal(packet.hopLimit, 3);
  assert.equal(packet.wantAck, false);
  assert.equal(packet.to, Constants.broadcastNum);
  assert.equal(new TextDecoder().decode(packet.payloadVariant.value.payload), "?310");
  assert.ok(core.log.some((l) => l.endsWith("demande ?310 envoyee")));
});

test("no request before the link is ready", async () => {
  const { radio } = setup(fakeTEcho());
  await assert.rejects(radio.sendRequest(310), /pas connecte/);
});
