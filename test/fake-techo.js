// fake-techo.js -- a simulated T-Echo behind a fake Web Bluetooth GATT
// server, speaking real Meshtastic protobuf. Used by test/radio.test.js in
// Node and by test/browser/harness.html in a real browser, where there is no
// Buffer -- the difference that hid the fourth bug.
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { Protobuf, Constants } from "@meshtastic/core";

const Mesh = Protobuf.Mesh;
const fieldSchema = (name) => Mesh.FromRadioSchema.fields.find((f) => f.localName === name).message;
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const ME = 0x974d3740;

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
export function fakeTEcho({
  nodes = 0, honourNonce = true, stepMs = 5, stallAfter = Infinity, notify = true,
  notifyStartMs = 300, garbleAfter = Infinity,
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
      // Firmware 2.7 order: the screen configuration comes right after the
      // identity -- a variant @meshtastic/core 2.6.7 does not handle.
      frame({ case: "deviceuiConfig", value: create(fieldSchema("deviceuiConfig"), {}) }),
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
    plan.push(frame({ case: "fileInfo", value: create(fieldSchema("fileInfo"), { fileName: "/prefs/db.proto" }) }));
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

  // Like Chrome on Android: one GATT operation at a time per device, each
  // taking a little while; starting another meanwhile fails. Enabling
  // notifications (a CCCD write) is the slow one.
  let busy = false;
  let goodReads = 0;
  const collisions = [];
  async function gattOp(name, ms, fn) {
    if (busy) {
      collisions.push(name);
      const err = new Error("GATT operation already in progress.");
      err.name = "NetworkError";
      throw err;
    }
    busy = true;
    try {
      await wait(ms);
      return fn();
    } finally {
      busy = false;
    }
  }

  const characteristic = (uuid) => ({
    uuid,
    readValue: () => gattOp("read", 10, () => {
      let bytes = outbox.shift() ?? new Uint8Array(0);
      if (bytes.length && goodReads++ >= garbleAfter) bytes = new Uint8Array([0xff, 0xff, 0xff, 0x0f, 0x01]);
      const copy = new Uint8Array(bytes);
      return new DataView(copy.buffer);
    }),
    writeValue: (buffer) => gattOp("write", 15, () => {
      const msg = fromBinary(Mesh.ToRadioSchema, new Uint8Array(buffer));
      written.push(msg);
      if (msg.payloadVariant.case === "wantConfigId") sendConfig(msg.payloadVariant.value);
    }),
    startNotifications: () => gattOp("startNotifications", notifyStartMs, () => {}),
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

  return { device, written, hear, collisions };
}


