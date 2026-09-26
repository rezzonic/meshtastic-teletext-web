// radio.js -- the Bluetooth link to the reader's own T-Echo.
//
// The only part that cannot be tested off the device. It feeds ReaderCore
// with what the radio hears and sends requests; every decision stays in
// core.js.
//
// A T-Echo accepts one Bluetooth connection at a time: while this app is
// connected, the Meshtastic app cannot use the same device.

import { create, toBinary } from "@bufbuild/protobuf";
import { MeshDevice, Protobuf, Constants } from "@meshtastic/core";
import { TransportWebBluetooth } from "@meshtastic/transport-web-bluetooth";
import { HOP_LIMIT, encodeRequest } from "./teletext.js";

const Status = {
  1: "redemarrage",
  2: "deconnecte",
  3: "connexion",
  4: "reconnexion",
  5: "connecte",
  6: "configuration",
  7: "pret",
};
const CONFIGURED = 7;
const DISCONNECTED = 2;

export function bluetoothAvailable() {
  return typeof navigator !== "undefined" && !!navigator.bluetooth;
}

export class Radio {
  /**
   * @param {import("./core.js").ReaderCore} core
   * @param {object} o
   * @param {string} o.channelName the teletext channel, "TXT"
   * @param {() => void} o.onChange called whenever something changed
   */
  constructor(core, { channelName, onChange }) {
    this.core = core;
    this.channelName = channelName;
    this.onChange = onChange;
    this.status = "deconnecte";
    this.btDevice = null;
    this.transport = null;
    this.device = null;
  }

  get connected() {
    return this.status === "pret";
  }

  _set(status) {
    this.status = status;
    this.onChange();
  }

  /** Ask the user to pick a T-Echo, then connect. Needs a user gesture. */
  async choose() {
    this.btDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [TransportWebBluetooth.ServiceUuid] }],
    });
    await this.connect();
  }

  /** Connect to the device chosen earlier; no chooser needed. */
  async connect() {
    if (!this.btDevice) return this.choose();
    this._set("connexion");
    try {
      this.transport = await TransportWebBluetooth.createFromDevice(this.btDevice);
      const device = new MeshDevice(this.transport);
      // The library logs every packet at trace level; warnings are enough.
      device.log.settings.minLevel = 4;
      this.device = device;
      this._listen(device);
      await device.configure();
    } catch (err) {
      this.core.error(`connexion impossible: ${err.message ?? err}`);
      this._set("deconnecte");
    }
  }

  async disconnect() {
    try {
      await this.transport?.disconnect();
    } catch {
      // already gone
    }
    this.device = null;
    this.transport = null;
    this._set("deconnecte");
  }

  _listen(device) {
    const core = this.core;
    core.channelIndex = null;
    const roles = Protobuf.Channel.Channel_Role;

    device.events.onDeviceStatus.subscribe((s) => {
      if (device !== this.device) return;
      this._set(Status[s] ?? String(s));
      if (s === CONFIGURED && core.channelIndex === null) {
        core.error(`pas de canal secondaire nomme ${this.channelName} sur ce T-Echo`);
        this.onChange();
      }
      if (s === DISCONNECTED) core.channelIndex = null;
    });

    device.events.onMyNodeInfo.subscribe((info) => {
      core.me = info.myNodeNum;
    });

    device.events.onChannelPacket.subscribe((channel) => {
      if (channel.role === roles.DISABLED) return;
      if (channel.settings?.name !== this.channelName) return;
      if (channel.index === 0 || channel.role === roles.PRIMARY) {
        // Never read or write the teletext on the primary: the public mesh.
        core.error(`${this.channelName} est le canal primaire: refuse`);
        return;
      }
      core.channelIndex = channel.index;
      this.onChange();
    });

    device.events.onMessagePacket.subscribe((message) => {
      try {
        if (core.onText(message.channel, message.from, message.data)) {
          this.onChange();
        }
      } catch (err) {
        core.error(`paquet ignore: ${err.message ?? err}`);
      }
    });
  }

  /**
   * Broadcast "?NNN" on the teletext channel with hop limit 1.
   *
   * Built by hand because MeshDevice.sendText() has no hop limit: at the
   * default of 3 a request would cost the mesh eight times as much.
   */
  async sendRequest(number) {
    if (!this.device || this.core.channelIndex === null) {
      throw new Error("pas connecte");
    }
    const id = crypto.getRandomValues(new Uint32Array(1))[0];
    const packet = create(Protobuf.Mesh.MeshPacketSchema, {
      payloadVariant: {
        case: "decoded",
        value: {
          payload: new TextEncoder().encode(encodeRequest(number)),
          portnum: Protobuf.Portnums.PortNum.TEXT_MESSAGE_APP,
        },
      },
      from: this.core.me ?? 0,
      to: Constants.broadcastNum,
      id,
      wantAck: false,
      channel: this.core.channelIndex,
      hopLimit: HOP_LIMIT,
    });
    const toRadio = create(Protobuf.Mesh.ToRadioSchema, {
      payloadVariant: { case: "packet", value: packet },
    });
    await this.device.sendRaw(toBinary(Protobuf.Mesh.ToRadioSchema, toRadio), id);
  }
}
