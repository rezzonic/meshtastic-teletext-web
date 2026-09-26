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

// Silence allowed while connecting, before we say it is stuck. It is reset by
// every item the T-Echo sends, so a long configuration is never cut short:
// only a device that stops answering is.
const SILENCE_TIMEOUT_MS = 20_000;

// Asked as want_config_id. Firmware that knows this nonce sends only its
// configuration, not one record per known node -- hundreds on a busy mesh,
// each a Bluetooth round trip. Firmware that does not know it echoes it back
// and sends everything, which is slower but still correct. The reader has no
// use for the node database.
const CONFIG_ONLY_NONCE = 69420;

const RECONNECT = "Touchez Reconnecter. Si cela se repete, verifiez que l'app "
  + "Meshtastic n'est pas connectee a ce T-Echo (forcez son arret).";
const STUCK_LINK = `lien Bluetooth bloque (T-Echo hors de portee ou pris). ${RECONNECT}`;
const STUCK_CONFIG = `le T-Echo n'envoie plus rien depuis ${SILENCE_TIMEOUT_MS / 1000} s. ${RECONNECT}`;

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
  constructor(core, { channelName, onChange, timers, silenceMs = SILENCE_TIMEOUT_MS }) {
    this.core = core;
    this.channelName = channelName;
    this.onChange = onChange;
    this.status = "deconnecte";
    this.btDevice = null;
    this.transport = null;
    this.device = null;
    this.watchdog = new Watchdog(silenceMs, () => this._stuck(), timers);
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
      const device = new MeshDevice(this.transport, CONFIG_ONLY_NONCE);
      // The library logs every packet at trace level; warnings are enough.
      device.log.settings.minLevel = 4;
      this.device = device;
      this._listen(device);
      this._log("demande de la configuration au T-Echo");
      // Not awaited: the library only settles this promise on an ack that a
      // want_config never gets, 60 s later. Progress shows in the events.
      device.configure().catch((err) => {
        if (device === this.device) this.core.error(`configuration: ${describe(err)}`);
      });
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
    const dog = this.watchdog;
    const counts = { nodes: 0, configs: 0 };

    // Everything the configuration is made of counts as progress.
    device.events.onNodeInfoPacket.subscribe(() => {
      dog.kick();
      counts.nodes += 1;
      if (counts.nodes % 25 === 0) this._log(`${counts.nodes} fiches de noeuds recues...`);
    });
    device.events.onConfigPacket.subscribe(() => { dog.kick(); counts.configs += 1; });
    device.events.onModuleConfigPacket.subscribe(() => { dog.kick(); counts.configs += 1; });
    device.events.onDeviceMetadataPacket.subscribe((meta) => {
      dog.kick();
      const version = meta?.data?.firmwareVersion;
      if (version) this._log(`firmware ${version}`);
    });

    device.events.onDeviceStatus.subscribe((s) => {
      if (device !== this.device) return;
      dog.kick();
      core.journal(`etat: ${Status[s] ?? s}`);
      if (s === CONFIGURED) {
        dog.stop();
        core.journal(`configuration recue: ${counts.nodes} fiches de noeuds, `
          + `${counts.configs} reglages`);
      }
      this._set(Status[s] ?? String(s));
      if (s === CONFIGURED && core.channelIndex === null) {
        core.error(`pas de canal secondaire nomme ${this.channelName} sur ce T-Echo`);
        this.onChange();
      }
      if (s === DISCONNECTED) core.channelIndex = null;
    });

    device.events.onMyNodeInfo.subscribe((info) => {
      dog.kick();
      core.me = info.myNodeNum;
      this._log(`noeud local !${(info.myNodeNum >>> 0).toString(16)}`);
    });

    device.events.onChannelPacket.subscribe((channel) => {
      dog.kick();
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
    if (!this.device || !this.connected || this.core.channelIndex === null) {
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
    // Not awaited: sendRaw settles only on a routing ack, and a broadcast sent
    // without wantAck never gets one -- it would "fail" 60 s later although
    // it went out. The expected timeout is ignored; anything else is shown.
    const device = this.device;
    device.sendRaw(toBinary(Protobuf.Mesh.ToRadioSchema, toRadio), id)
      .catch((err) => {
        if (err?.error === Protobuf.Mesh.Routing_Error.TIMEOUT) return;
        if (device === this.device) this.core.error(`demande ${encodeRequest(number)}: ${describe(err)}`);
      });
    this._log(`demande ${encodeRequest(number)} envoyee`);
  }
}
