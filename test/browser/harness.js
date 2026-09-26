// The Radio against the simulated T-Echo, in a real browser: no Buffer, no
// Node. Built with the app's own Vite config (aliases, defines), so it runs
// the code that is published. Result in window.__result for the test driver.
import { ReaderCore } from "../../src/core.js";
import { Radio } from "../../src/radio.js";
import { fakeTEcho, wait } from "../fake-techo.js";

async function until(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await wait(20);
  return check();
}

async function run() {
  const result = { hasBuffer: typeof Buffer !== "undefined" };
  const echo = fakeTEcho({ notify: false });
  const core = new ReaderCore();
  const radio = new Radio(core, { channelName: "TXT", onChange: () => {}, silenceMs: 3000 });
  radio.btDevice = echo.device;
  await radio.connect();
  result.ready = await until(() => radio.status === "pret", 8000);
  result.channel = core.channelIndex;
  echo.hear("T101 1/1 14:40\nMETEO TEST");
  result.page = await until(() => core.registry.has(101), 4000);
  await radio.sendRequest(310);
  result.request = await until(() => echo.written.some((m) => m.payloadVariant.case === "packet"), 3000);
  result.collisions = echo.collisions;
  result.log = core.log;
  await radio.disconnect();
  return result;
}

run().then((r) => {
  window.__result = r;
  document.getElementById("out").textContent = JSON.stringify(r, null, 1);
}, (err) => {
  window.__result = { crash: `${err.name}: ${err.message}` };
});
