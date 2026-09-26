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
import { Watchdog } from "./core.js";
import { HOP_LIMIT, encodeRequest, pad3 } from "./teletext.js";

// How long configuration may take before we say it is stuck. A T-Echo sends
// its whole configuration in a few seconds over Bluetooth.
const CONFIGURE_TIMEOUT_MS = 25_000;

// Both stalls have the same usual cause: another app holds the T-Echo.
const ADVICE = "L'app Meshtastic est peut-etre encore connectee a ce T-Echo: "
  + "deconnectez-la, forcez son arret, puis Reconnecter.";
const STUCK_LINK = `lien Bluetooth bloque (T-Echo hors de portee ou pris). ${ADVICE}`;
const STUCK_CONFIG = `configuration bloquee. ${ADVICE}`;

function describe(err) {
  return err?.name ? `${err.name}: ${err.message}` : String(err);
}

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
  constructor(core, { channelName, onChange, timers }) {
    this.core = core;
    this.channelName = channelName;
    this.onChange = onChange;
    this.status = "deconnecte";
    this.btDevice = null;
    this.transport = null;
    this.device = null;
    this.watchdog = new Watchdog(CONFIGURE_TIMEOUT_MS, () => this._stuck(), timers);
  }

  get connected() {
    return this.status === "pret";
  }

  _set(status) {
    this.status = status;
    this.onChange();
  }

  _log(text) {
    this.core.journal(text);
    this.onChange();
  }

  /** Ask the user to pick a T-Echo, then connect. Needs a user gesture. */
  async choose() {
    this._log("ouverture de la liste Bluetooth de Chrome");
    this.btDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [TransportWebBluetooth.ServiceUuid] }],
    });
    this._log(`appareil choisi: ${this.btDevice.name ?? "(sans nom)"}`);
    await this.connect();
  }

  /** Connect to the device chosen earlier; no chooser needed. */
  async connect() {
    if (!this.btDevice) return this.choose();
    this._set("connexion");
    this.watchdog.start();
    try {
      this._log("connexion Bluetooth (GATT)...");
      this.transport = await TransportWebBluetooth.createFromDevice(this.btDevice);
      this._log("lien Bluetooth etabli, service Meshtastic trouve");
      const device = new MeshDevice(this.transport);
      // The library logs every packet at trace level; warnings are enough.
      device.log.settings.minLevel = 4;
      this.device = device;
      this._listen(device);
      this._log("demande de la configuration au T-Echo");
      await device.configure();
      this._log("demande de configuration envoyee");
    } catch (err) {
      this.watchdog.stop();
      this.core.error(`connexion impossible: ${describe(err)}`);
      this._set("deconnecte");
    }
  }

  /** Configuration never completed: say why it probably did not, and let go
   * of the link so that Reconnecter starts from scratch. */
  async _stuck() {
    this.core.error(this.transport ? STUCK_CONFIG : STUCK_LINK);
    await this.disconnect();
  }

  async disconnect() {
    this.watchdog.stop();
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
      core.journal(`etat: ${Status[s] ?? s}`);
      if (s === CONFIGURED) this.watchdog.stop();
      this._set(Status[s] ?? String(s));
      if (s === CONFIGURED && core.channelIndex === null) {
        core.error(`pas de canal secondaire nomme ${this.channelName} sur ce T-Echo`);
        this.onChange();
      }
      if (s === DISCONNECTED) core.channelIndex = null;
    });

    device.events.onMyNodeInfo.subscribe((info) => {
      core.me = info.myNodeNum;
      this._log(`noeud local !${(info.myNodeNum >>> 0).toString(16)}`);
    });

    device.events.onChannelPacket.subscribe((channel) => {
      if (channel.role !== roles.DISABLED) {
        this._log(`canal ${channel.index} ${roles[channel.role] ?? channel.role} `
          + `"${channel.settings?.name ?? ""}"`);
      }
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
        const page = core.onText(message.channel, message.from, message.data);
        if (page) this._log(`T${pad3(page.number)} recue`);
      } catch (err) {
        core.error(`paquet ignore: ${describe(err)}`);
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
