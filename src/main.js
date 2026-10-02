// main.js -- wires the core, the radio, storage and the screen together.

import { ReaderCore } from "./core.js";
import { Radio, bluetoothAvailable } from "./radio.js";
import { sirenSvg, splitSignature } from "./sirens.js";
import {
  CHANNEL_NAME, INDEX_PAGE, agoFr, hhmm, pad3,
} from "./teletext.js";

const STORAGE_KEY = "teletext.pages.v1";
const DEMO = new URLSearchParams(location.search).has("demo");

const core = new ReaderCore({ staleMinutes: 45 });
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- storage
// The cache survives closing the app: a page missed on this cycle is still
// here, with its true age. Browser storage can be unavailable (private
// mode, cleared data), so every access is guarded.

function loadPages() {
  try {
    core.registry.load(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"));
  } catch {
    // start empty
  }
}

function savePages() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(core.registry.toJSON()));
  } catch {
    // not fatal: the cache just will not survive a restart
  }
}

// ------------------------------------------------------------------ radio

let radio;

if (DEMO) {
  radio = demoRadio();
} else {
  radio = new Radio(core, { channelName: CHANNEL_NAME, onChange: changed });
}

// Once per connection, ask for the index (core.wantsGreeting): without it a
// reader would wait forever, the server sends nothing unasked.
let greeted = false;

function changed() {
  savePages();
  const ready = radio.connected && core.channelIndex !== null;
  if (!ready) {
    greeted = false;
  } else if (!greeted) {
    greeted = true;
    if (core.wantsGreeting()) {
      core.journal("connexion: demande de l'index");
      return ask(INDEX_PAGE, true);
    }
  }
  render();
}

async function ask(number, force) {
  const { ok, why } = core.wantRequest(number, force);
  if (!ok) {
    core.note = why;
    return render();
  }
  try {
    await radio.sendRequest(number);
    core.markRequested(number);
    core.note = `T${pad3(number)} demandee`;
  } catch (err) {
    core.error(`demande non envoyee: ${err.message ?? err}`);
  }
  render();
}

function arrive(number) {
  core.note = "";
  if (core.needsRequest(number) && core.channelIndex !== null) {
    ask(number, false);
  } else {
    render();
  }
}

// ----------------------------------------------------------------- screen

function render() {
  const now = core.now();
  const number = core.current;
  const page = core.registry.get(number);

  const pageno = $("pageno");
  if (core.typed) {
    pageno.textContent = `P${core.typed.padEnd(3, "_")}`;
    pageno.classList.add("typing");
  } else {
    pageno.textContent = `P${pad3(number)}`;
    pageno.classList.remove("typing");
  }
  $("clock").textContent = hhmm(now);

  const age = $("age");
  const body = $("body");
  const drawing = $("drawing");
  age.className = "age";
  if (page) {
    // The three times of PROTOCOL.md: generated, from the source, and
    // received -- which is when it went on air, to a few seconds.
    const stale = core.isStale(number);
    const day = `${String(page.produced.getDate()).padStart(2, "0")}.`
      + `${String(page.produced.getMonth() + 1).padStart(2, "0")}`;
    const lines = [{
      text: `generee le ${day} a ${hhmm(page.produced)}, il y a `
        + `${agoFr(core.ageS(number))}${stale ? " - ANCIENNE" : ""}`,
      cls: stale ? "stale" : "",
    }];
    const more = [];
    if (page.source) more.push(`source ${hhmm(page.source)}`);
    if (page.received) {
      more.push(`recue a ${hhmm(page.received)}, il y a `
        + agoFr((now - page.received) / 1000));
    }
    if (more.length) lines.push({ text: more.join(" · "), cls: "times" });
    if (page.failing) {
      lines.push({ text: "! mise a jour en echec : contenu precedent", cls: "failing" });
    }
    age.replaceChildren(...lines.map(({ text, cls }) => Object.assign(
      document.createElement("div"), { textContent: text, className: cls })));
    // Pages 311 and 312: the signature line becomes a drawing of the tone.
    const { kind, body: text } = splitSignature(page);
    if (drawing.dataset.kind !== (kind ?? "")) {
      drawing.innerHTML = kind ? sirenSvg(kind) : ""; // our own markup only
      drawing.dataset.kind = kind ?? "";
    }
    drawing.hidden = !kind;
    const [first, ...rest] = text.split("\n");
    body.replaceChildren(
      Object.assign(document.createElement("span"),
        { className: "title", textContent: first }),
      document.createTextNode(rest.length ? `\n${rest.join("\n")}` : ""));
  } else {
    drawing.hidden = true;
    age.textContent = "pas encore recue";
    age.classList.add("missing");
    const asked = core.askedAt.get(number);
    body.textContent = asked
      ? `Demandee a ${hhmm(asked)}, en attente.`
      : "Touchez Demander pour la demander au serveur.";
  }

  const held = $("held");
  const numbers = core.registry.numbers();
  held.replaceChildren(...numbers.map((n) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = pad3(n);
    if (n === number) b.setAttribute("aria-current", "true");
    b.addEventListener("click", () => { core.goto(n); core.note = ""; render(); });
    return b;
  }));
  if (!numbers.length) held.textContent = "rien pour l'instant";

  $("note").textContent = core.note;
  const error = $("error");
  error.hidden = !core.errors.length;
  if (core.errors.length) {
    error.textContent = `${core.errors[0].time} ${core.errors[0].text}`;
  }

  $("journal-count").textContent = core.log.length ? `(${core.log.length})` : "";
  const lines = core.log.join("\n");
  if ($("journal-lines").textContent !== lines) $("journal-lines").textContent = lines;

  const status = $("status");
  status.className = "status";
  const connect = $("connect");
  if (DEMO) {
    status.textContent = "demo";
    status.classList.add("demo");
    connect.hidden = true;
  } else {
    const label = radio.status === "pret" && core.channelIndex !== null
      ? `${CHANNEL_NAME} canal ${core.channelIndex}` : radio.status;
    status.textContent = label;
    if (radio.connected) status.classList.add("ok");
    connect.textContent = radio.connected ? "Deconnecter"
      : radio.btDevice ? "Reconnecter" : "Connecter";
    connect.disabled = ["connexion", "configuration", "reconnexion"]
      .includes(radio.status);
  }
}

// ----------------------------------------------------------------- inputs

function digit(d) {
  const number = core.digit(d);
  if (number !== null) arrive(number);
  else render();
}

const actions = {
  // Browsing the cache never transmits; only asking for a number does.
  prev: () => { core.step(-1); core.note = ""; render(); },
  next: () => { core.step(+1); core.note = ""; render(); },
  index: () => { core.goto(INDEX_PAGE); arrive(INDEX_PAGE); },
  back: () => { core.backspace(); render(); },
  ask: () => ask(core.current, true),
};

document.querySelector(".pad").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.digit !== undefined) digit(Number(button.dataset.digit));
  else actions[button.dataset.act]?.();
});

document.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const k = event.key;
  if (/^[0-9]$/.test(k)) digit(Number(k));
  else if (k === "ArrowRight" || k === "n") actions.next();
  else if (k === "ArrowLeft" || k === "p") actions.prev();
  else if (k === "Backspace") actions.back();
  else if (k === "Escape") { core.typed = ""; render(); }
  else if (k === "i") actions.index();
  else if (k === "r" || k === "Enter") actions.ask();
  else return;
  event.preventDefault();
});

$("connect").addEventListener("click", async () => {
  try {
    if (radio.connected) await radio.disconnect();
    else if (radio.btDevice) await radio.connect();
    else await radio.choose();
  } catch (err) {
    // Closing the device chooser lands here too; that is not an error.
    if (err?.name === "NotFoundError") core.journal("liste fermee sans choix");
    else core.error(`${err?.name ?? "Erreur"}: ${err?.message ?? err}`);
    render();
  }
});

$("journal-copy").addEventListener("click", async () => {
  const text = [
    `teletext-web ${location.href}`,
    `navigateur ${navigator.userAgent}`,
    `etat ${radio.status}, canal ${core.channelIndex ?? "?"}`,
    ...core.log,
  ].join("\n");
  try {
    await navigator.clipboard.writeText(text);
    core.note = "journal copie";
  } catch {
    // No clipboard permission: select the text so it can be copied by hand.
    getSelection().selectAllChildren($("journal-lines"));
    core.note = "selectionnez et copiez le journal a la main";
  }
  render();
});

// Coming back to the app after the phone slept: offer the link again.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") render();
});

// ------------------------------------------------------------------- demo

function demoRadio() {
  // No radio: sample pages, and requests answered after a short delay as
  // the server would. For trying the interface, and for its tests.
  core.channelIndex = 2;
  const minutesAgo = (m) => {
    const d = new Date(Date.now() - m * 60_000);
    return hhmm(d);
  };
  const samples = {
    100: "INDEX\n101 MÉTÉO 3m\n201 ACTUALITÉS 3m\n301 ALERTES 3m\n310 SIRÈNES 3m\n"
      + "401 ÉTAT DU MAILLAGE 3m",
    401: "MAILLAGE\n7 nœuds entendus <2h\ndirects 3, 1 saut 2, plus loin 2\n"
      + "À portée: 7 (jusqu'à 3 sauts)\nDirects (SNR dB):\n"
      + "KNZ1 +6.5  ABCD -2.0  EFGH ?\nsuite: 402",
    402: "MAILLAGE (suite)\n1 saut:\nBULL  ROMT\n2 sauts:\nFRI1  GRUY",
    101: "MÉTÉO DÉMO\nAuj 18/9  couvert\nDem 20/11 soleil\nLun 15/8  pluie 12mm",
    201: "ACTUALITÉS\n- Premier titre de démonstration\n- Deuxième titre\n- Troisième titre",
    301: "ALERTES (non officiel)\naucune alerte en cours\n(FR)",
    310: "SIRÈNES\n311 Alarme générale\n312 Alarme eau\n313 Plus d'informations\n"
      + "Test des sirènes: premier mercredi de février\n"
      + "Prochain test: mer 3.2.2027 13h30",
    311: "ALARME GÉNÉRALE\nSon: /\\/\\/\\/\\/\\/\\ 1 min\n"
      + "Son oscillant continu 1 min, répété après 5 min.\n"
      + "- Allumer la radio\n- Suivre les consignes\n- Informer les voisins",
    312: "ALARME EAU\nSon: __ __ __ __ __ x12\n"
      + "12 sons graves de 20 s, pauses de 10 s. Près des barrages.\n"
      + "- Quitter immédiatement la zone menacée",
    313: `PLUS D'INFORMATIONS\nAlertes (FR) à ${minutesAgo(0)}:\naucune en cours\n`
      + "Non officiel: alert.swiss, radio",
  };
  // A source time on 101, a failed update on 201: what the header can say.
  const extra = (n, age) => ({ 101: ` s${minutesAgo(age + 25)}`, 201: " !" }[n] ?? "");
  const heard = (n, age) => core.onText(2, 9,
    `T${pad3(n)} 1/1 ${minutesAgo(age)}${extra(n, age)}\n${samples[n]}`);
  heard(100, 3);
  heard(101, 3);
  heard(201, 3);
  heard(301, 50);
  return {
    status: "demo",
    connected: true,
    btDevice: null,
    async sendRequest(number) {
      setTimeout(() => {
        if (samples[number]) {
          heard(number, 0);
          render();
        }
      }, 1500);
    },
  };
}

// ------------------------------------------------------------------ start

if (!DEMO) loadPages();
core.journal(DEMO ? "mode demo, sans radio"
  : bluetoothAvailable() ? "pret: touchez Connecter" : "Web Bluetooth indisponible");
if (!DEMO && !bluetoothAvailable()) $("unsupported").hidden = false;
render();
setInterval(render, 1000); // ages move even when nothing arrives

if ("serviceWorker" in navigator && import.meta.env?.PROD) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
