// Radio against a simulated T-Echo: the real @meshtastic/core and the real
// Web Bluetooth transport, talking protobuf to a fake GATT server. What this
// cannot know is how a real phone and firmware time things; it does check
// the protocol, the journal, the watchdog and the request packet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { Protobuf, Constants } from "@meshtastic/core";
import { ReaderCore } from "../src/core.js";
import { Radio } from "../src/radio.js";

const Mesh = Protobuf.Mesh;
const ME = 0x974d3740;

function frame(variant) {
  const msg = create(Mesh.FromRadioSchema, { id: 0, payloadVariant: variant });
  return toBinary(Mesh.FromRadioSchema, msg);
}

/**
 * A fake T-Echo behind a fake GATT server.
 * @param {object} o
 * @param {number} o.nodes node records sent unless the config-only nonce is used
 * @param {boolean} o.honourNonce whether it knows the 69420 nonce
 * @param {number} o.stepMs delay between two configuration items
 * @param {number} o.stallAfter stop answering after this many items
 */
function fakeTEcho({
  nodes = 0, honourNonce = true, stepMs = 5, stallAfter = Infinity, notify = true,
} = {}) {
  const outbox = [];
  const written = [];
  const listeners = new Set();
  let items = 0;

  // Each item becomes readable `stepMs` after the previous one, like the
  // T-Echo preparing them one by one; a read in between comes back empty.
  const push = (bytes) => {
    outbox.push(bytes);
    if (notify) for (const fn of listeners) fn();
  };

  function sendConfig(nonce) {
    const plan = [
      frame({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: ME }) }),
      frame({ case: "metadata", value: create(Mesh.DeviceMetadataSchema, { firmwareVersion: "2.7.9" }) }),
    ];
    const n = honourNonce && nonce === 69420 ? 0 : nodes;
    for (let i = 0; i < n; i++) {
      plan.push(frame({ case: "nodeInfo", value: create(Mesh.NodeInfoSchema, { num: i + 1 }) }));
    }
    const channel = (index, role, name) => frame({
      case: "channel",
      value: create(Protobuf.Channel.ChannelSchema, { index, role, settings: { name } }),
    });
    const R = Protobuf.Channel.Channel_Role;
    plan.push(channel(0, R.PRIMARY, ""), channel(1, R.SECONDARY, "KNZ"),
      channel(2, R.SECONDARY, "TXT"), channel(3, R.DISABLED, ""));
    plan.push(frame({ case: "configCompleteId", value: nonce }));
    let k = 0;
    const tick = () => {
      if (k >= plan.length || items >= stallAfter) return;
      items += 1;
      push(plan[k++]);
      setTimeout(tick, stepMs);
    };
    tick();
  }

  const characteristic = (uuid) => ({
    uuid,
    async readValue() {
      const bytes = outbox.shift() ?? new Uint8Array(0);
      const copy = new Uint8Array(bytes);
      return new DataView(copy.buffer);
    },
    async writeValue(buffer) {
      const msg = fromBinary(Mesh.ToRadioSchema, new Uint8Array(buffer));
      written.push(msg);
      if (msg.payloadVariant.case === "wantConfigId") sendConfig(msg.payloadVariant.value);
    },
    async startNotifications() {},
    stopNotifications() {},
    addEventListener(_type, fn) { listeners.add(fn); },
    removeEventListener(_type, fn) { listeners.delete(fn); },
  });

  const gatt = {
    connected: true,
    device: null,
    async connect() { return gatt; },
    disconnect() { gatt.connected = false; },
    async getPrimaryService() {
      return { getCharacteristic: async (uuid) => characteristic(uuid) };
    },
  };
  const device = {
    name: "Meshtastic_3740",
    gatt,
    addEventListener() {},
    removeEventListener() {},
  };
  gatt.device = device;

  /** A text message heard on `channel`, as the radio would pass it up. */
  function hear(text, channel = 2, from = 0x1111) {
    const packet = create(Mesh.MeshPacketSchema, {
      from, to: Constants.broadcastNum, channel, id: 7,
      payloadVariant: {
        case: "decoded",
        value: { portnum: Protobuf.Portnums.PortNum.TEXT_MESSAGE_APP,
          payload: new TextEncoder().encode(text) },
      },
    });
    push(frame({ case: "packet", value: packet }));
  }

  return { device, written, hear };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  assert.ok(core.log.some((l) => /lectures \d+ \(dont \d+ vides\), notifications 0/.test(l)),
    core.log.join("\n"));
  echo.hear("T301 1/1 14:40\nALERTES");
  assert.ok(await until(() => core.registry.has(301), 3000), "page read by the idle poll");
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

test("a request goes out on TXT with hop limit 1, without waiting for an ack", async (t) => {
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
  assert.equal(packet.hopLimit, 1);
  assert.equal(packet.wantAck, false);
  assert.equal(packet.to, Constants.broadcastNum);
  assert.equal(new TextDecoder().decode(packet.payloadVariant.value.payload), "?310");
  assert.ok(core.log.some((l) => l.endsWith("demande ?310 envoyee")));
});

test("no request before the link is ready", async () => {
  const { radio } = setup(fakeTEcho());
  await assert.rejects(radio.sendRequest(310), /pas connecte/);
});
