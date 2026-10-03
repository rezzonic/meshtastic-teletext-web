// radio.js -- the Bluetooth link to the reader's own T-Echo.
//
// The only part that cannot be tested off the device. It feeds ReaderCore
// with what the radio hears and sends requests; every decision stays in
// core.js.
//
// A T-Echo accepts one Bluetooth connection at a time: while this app is
// connected, the Meshtastic app cannot use the same device.

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
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

// The transport reads the T-Echo only after a write and when the T-Echo
// notifies "fromNum". Polling goes through the GATT lock like everything
// else, so it waits its turn instead of colliding with a write. One empty read while the device is still preparing its
// next item (the nRF52 of a T-Echo prepares them asynchronously), plus a
// notification that never comes, and nothing is ever read again: the first
// real run stopped right after the node identity. So we also read on a
// timer -- fast while configuring, slowly afterwards so pages still arrive
// if notifications do not. An empty read is a few bytes over Bluetooth.
const POLL_CONFIGURING_MS = 150;
const POLL_IDLE_MS = 1000;

const RECONNECT ="Touchez Reconnecter. Si cela se repete, verifiez que l'app "
  + "Meshtastic n'est pas connectee a ce T-Echo (forcez son arret).";
const STUCK_LINK = `lien Bluetooth bloque (T-Echo hors de portee ou pris). ${RECONNECT}`;
const STUCK_CONFIG = `le T-Echo n'envoie plus rien depuis ${SILENCE_TIMEOUT_MS / 1000} s. ${RECONNECT}`;

function describe(err) {
  return err?.name ? `${err.name}: ${err.message}` : String(err);
}

/**
 * One GATT operation at a time for the whole device. Chrome on Android
 * rejects an operation started while another is running ("GATT operation
 * already in progress"), and the transport does not serialise its own: its
 * queue writes 200 ms after start without waiting for notifications to be
 * enabled, and reads can overlap writes. That is what failed the
 * want_config write on the third real run.
 */
function gattLock(stats, onError) {
  let chain = Promise.resolve();
  let inFlight = 0;
  function run(name, fn) {
    if (inFlight > 0) stats.waited += 1;
    inFlight += 1;
    const result = chain.then(fn);
    chain = result.catch(() => {}).finally(() => { inFlight -= 1; });
    result.catch((err) => onError(name, err));
    return result;
  }
  return {
    /** Route these methods of a characteristic through the lock. */
    wrap(characteristic, names) {
      for (const name of names) {
        const original = characteristic[name]?.bind(characteristic);
        if (original) characteristic[name] = (...args) => run(name, () => original(...args));
      }
    },
  };
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
const CONNECTED = 5;
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
      this.transport = await this._openTransport(this.btDevice);
      this._log("lien Bluetooth établi, service Meshtastic trouvé");
      const device = new MeshDevice(this.transport, CONFIG_ONLY_NONCE);
      this._tameLogger(device.log);
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
    if (this.transport) this._logStats();
    this.core.error(this.transport ? STUCK_CONFIG : STUCK_LINK);
    await this.disconnect();
  }

  /**
   * TransportWebBluetooth.prepareConnection, but with every GATT operation
   * going through one lock -- installed before the transport exists, so
   * that enabling notifications, done in its constructor, is covered too.
   * Also counts reads, empty reads and notifications for the journal.
   */
  async _openTransport(btDevice) {
    const gatt = await btDevice.gatt.connect();
    const service = await gatt.getPrimaryService(TransportWebBluetooth.ServiceUuid);
    const toRadio = await service.getCharacteristic(TransportWebBluetooth.ToRadioUuid);
    const fromRadio = await service.getCharacteristic(TransportWebBluetooth.FromRadioUuid);
    const fromNum = await service.getCharacteristic(TransportWebBluetooth.FromNumUuid);

    const stats = { reads: 0, empty: 0, notifications: 0, waited: 0 };
    this.stats = stats;
    const lock = gattLock(stats, (name, err) => {
      this.core.error(`GATT ${name}: ${describe(err)}`);
    });
    for (const characteristic of [toRadio, fromRadio, fromNum]) {
      lock.wrap(characteristic, ["readValue", "writeValue", "startNotifications",
        "stopNotifications"]);
    }
    const read = fromRadio.readValue;
    fromRadio.readValue = async () => {
      const value = await read();
      stats.reads += 1;
      const size = value.byteLength;
      if (size === 0) {
        stats.empty += 1;
      } else {
        stats.minSize = Math.min(stats.minSize ?? size, size);
        stats.maxSize = Math.max(stats.maxSize ?? size, size);
        this._checkDecodes(value);
      }
      return value;
    };
    fromNum.addEventListener("characteristicvaluechanged", () => {
      stats.notifications += 1;
    });
    return new TransportWebBluetooth(toRadio, fromRadio, fromNum, gatt);
  }

  /** Journal the first few reads that do not decode, as hex, so that a
   * truncated or mixed-up read can be seen rather than guessed. */
  _checkDecodes(view) {
    if ((this.undecodable ?? 0) >= 3) return;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    try {
      fromBinary(Protobuf.Mesh.FromRadioSchema, bytes);
    } catch (err) {
      this.undecodable = (this.undecodable ?? 0) + 1;
      const hex = [...bytes.slice(0, 48)].map((b) => b.toString(16).padStart(2, "0")).join("");
      this.core.journal(`lecture illisible (${bytes.length} o): ${hex} -- ${describe(err)}`);
    }
  }

  _logStats() {
    const s = this.stats;
    if (s) {
      this.core.journal(`lectures ${s.reads} (dont ${s.empty} vides, tailles `
        + `${s.minSize ?? "-"}..${s.maxSize ?? "-"} octets), notifications `
        + `${s.notifications}, operations mises en attente ${s.waited}`);
    }
    const kinds = Object.entries(this.kinds ?? {}).map(([k, n]) => `${k} ${n}`);
    if (kinds.length) this.core.journal(`éléments reçus : ${kinds.join(", ")}`);
  }

  /**
   * The logger bundled in @meshtastic/core is tslog's Node build. For every
   * message it lets through it masks "password" values, and that code calls
   * Buffer.isBuffer -- which does not exist in a browser. So the first warning
   * threw inside the decoding stream and killed it silently. Firmware 2.7
   * sends a deviceuiConfig right after the node identity, a variant the
   * library does not handle and warns about: the identity arrived, then
   * nothing was ever understood again.
   *
   * Make isBuffer safe (the runtime object is shared by every logger), skip
   * masking and formatting, and copy warnings and errors to the journal.
   */
  _tameLogger(log) {
    log.runtime.isBuffer = () => false;
    log.settings.maskValuesOfKeys = [];
    log.settings.type = "hidden";
    log.settings.minLevel = 4; // warnings and errors; trace is every packet
    const seen = new Set();
    log.attachTransport((entry) => {
      const parts = [];
      for (let i = 0; i in entry; i += 1) {
        const arg = entry[i];
        parts.push(arg?.message ?? (typeof arg === "string" ? arg : JSON.stringify(arg)));
      }
      const text = parts.slice(1).join(" ").trim(); // parts[0] is the emitter
      if (!text || seen.has(text) || seen.size > 20) return;
      seen.add(text);
      this.core.journal(`biblio: ${text}`);
    });
  }

  /** Read whatever the T-Echo has, every `ms`, without waiting to be told. */
  _poll(ms) {
    clearInterval(this.poller);
    this.poller = setInterval(() => {
      // readFromRadio returns at once if a read is already running.
      this.transport?.readFromRadio?.().catch(() => {});
    }, ms);
  }

  async disconnect() {
    this.watchdog.stop();
    clearInterval(this.poller);
    this.poller = null;
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
    this.kinds = {};
    this.undecodable = 0;

    // Every item that decodes, of any kind, is progress; and the tally says
    // what the firmware actually sent.
    device.events.onFromRadio.subscribe((message) => {
      dog.kick();
      const kind = message.payloadVariant?.case ?? "inconnu";
      this.kinds[kind] = (this.kinds[kind] ?? 0) + 1;
    });

    // Everything the configuration is made of counts as progress.
    device.events.onNodeInfoPacket.subscribe(() => {
      dog.kick();
      counts.nodes += 1;
      if (counts.nodes % 25 === 0) this._log(`${counts.nodes} fiches de nœuds reçues...`);
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
      core.journal(`état : ${Status[s] ?? s}`);
      if (s === CONNECTED && !this.connected) this._poll(POLL_CONFIGURING_MS);
      if (s === CONFIGURED) {
        dog.stop();
        this._poll(POLL_IDLE_MS);
        core.journal(`configuration reçue : ${counts.nodes} fiches de nœuds, `
          + `${counts.configs} réglages`);
        this._logStats();
      }
      this._set(Status[s] ?? String(s));
      if (s === CONFIGURED && core.channelIndex === null) {
        core.error(`pas de canal secondaire nommé ${this.channelName} sur ce T-Echo`);
        this.onChange();
      }
      if (s === DISCONNECTED) core.channelIndex = null;
    });

    device.events.onMyNodeInfo.subscribe((info) => {
      dog.kick();
      core.me = info.myNodeNum;
      this._log(`nœud local !${(info.myNodeNum >>> 0).toString(16)}`);
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
        core.error(`${this.channelName} est le canal primaire : refusé`);
        return;
      }
      core.channelIndex = channel.index;
      this.onChange();
    });

    device.events.onMessagePacket.subscribe((message) => {
      try {
        const page = core.onText(message.channel, message.from, message.data);
        if (page) this._log(`T${pad3(page.number)} reçue`);
      } catch (err) {
        core.error(`paquet ignoré : ${describe(err)}`);
      }
    });
  }

  /**
   * Broadcast "?NNN" on the teletext channel with hop limit HOP_LIMIT (3).
   *
   * Built by hand because MeshDevice.sendText() sets no hop limit of its
   * own -- the device default could be anything -- and the server measures
   * our distance from hopStart, which must be what we chose.
   */
  async sendRequest(number) {
    if (!this.device || !this.connected || this.core.channelIndex === null) {
      throw new Error("pas connecté");
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
    this._log(`demande ${encodeRequest(number)} envoyée`);
  }
}
