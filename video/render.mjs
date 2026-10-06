/** Renders demo.html to docs/demo.mp4: 1920 x 1080, silent.
 *
 *   node render.mjs                 writes ../docs/demo.mp4 at 30 fps
 *   node render.mjs --fps 60        60 fps
 *   node render.mjs --at 4.2,9.4    writes only those moments, as review/demo-at-4.2.png and so on
 *
 * No packages: headless Chrome is driven over the DevTools protocol with Node's own WebSocket, one seek(t)
 * and one screenshot per frame, and the frames are piped straight into ffmpeg. The page must expose
 * window.seek(t), window.DURATION and window.videoReady. Needs Chrome, and an ffmpeg built with libx264.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : fallback; };
const FPS = Number(arg("fps", 30));
const TAG = arg("tag", "");
const NAME = arg("page", "demo");
const [WIDTH, HEIGHT] = arg("size", "1920x1080").split("x").map(Number);   // --size 1080x1350 for the 4:5 clips
const SILENT = true;
const PAGE = new URL(`./${NAME}.html?render=1`, import.meta.url).href;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FFMPEG = process.env.FFMPEG || "ffmpeg";

async function launchChrome() {
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", "--hide-scrollbars", "--mute-audio", "--allow-file-access-from-files",
    "--force-device-scale-factor=1", `--window-size=${WIDTH},${HEIGHT}`, "--no-first-run", "--no-default-browser-check", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] });
  const address = await new Promise((resolve, reject) => {
    let said = "";
    chrome.stderr.on("data", (chunk) => { said += chunk; const found = said.match(/DevTools listening on (ws:\/\/\S+)/); if (found) resolve(found[1]); });
    chrome.on("error", reject);
    chrome.on("exit", (code) => reject(new Error(`Chrome stopped before it was ready (${code})`)));
  });
  return { chrome, address };
}

async function connect(address) {
  const socket = new WebSocket(address);
  const waiting = new Map(), events = [];
  let next = 0, session;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data), pending = waiting.get(message.id);
    if (pending) { waiting.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); }
    else events.forEach((listener) => listener(message));
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not reach Chrome")), { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, sessionId: session }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  ({ sessionId: session } = await send("Target.attachToTarget", { targetId, flatten: true }));
  const on = (method, fn) => events.push((message) => { if (message.method === method) fn(message.params); });
  const nextEvent = (method) => new Promise((resolve) => on(method, resolve));
  return { send, on, nextEvent, close: () => socket.close() };
}

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
}

async function frameAt(cdp, seconds) {
  await evaluate(cdp, `seek(${seconds})`);
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  return Buffer.from(data, "base64");
}

async function main() {
  const { chrome, address } = await launchChrome();
  try {
    const cdp = await connect(address);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const errors = [];
    cdp.on("Runtime.exceptionThrown", (p) => errors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text));
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    const loaded = cdp.nextEvent("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: PAGE });
    await loaded;
    await evaluate(cdp, "window.videoReady");
    if (errors.length) throw new Error("The page threw: " + errors.join(" | "));
    const seconds = await evaluate(cdp, "window.DURATION");

    if (process.argv.includes("--at")) {
      await mkdir(new URL("./review/", import.meta.url), { recursive: true });
      for (const moment of arg("at", "").split(",").filter(Boolean)) {
        await writeFile(new URL(`./review/${NAME}-at-${moment}.png`, import.meta.url), await frameAt(cdp, Number(moment)));
      }
      if (errors.length) throw new Error("The page threw: " + errors.join(" | "));
      cdp.close();
      return;
    }

    
    const frames = Math.round(seconds * FPS);
    const audio = fileURLToPath(new URL("./assets/clip.wav", import.meta.url));
    const video = fileURLToPath(new URL(`../docs/${NAME}${TAG ? "-" + TAG : ""}.mp4`, import.meta.url));
    const ffmpeg = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-", ...(SILENT ? [] : ["-i", audio, "-map", "0:v", "-map", "1:a"]), "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-profile:v", "high", "-r", String(FPS),
      ...(SILENT ? [] : ["-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-shortest"]), "-movflags", "+faststart", video], { stdio: ["pipe", "inherit", "inherit"] });
    const finished = once(ffmpeg, "exit");
    for (let i = 0; i < frames; i++) {
      if (!ffmpeg.stdin.write(await frameAt(cdp, i / FPS))) await once(ffmpeg.stdin, "drain");
      if (i % (FPS * 5) === 0) process.stdout.write(`${i / FPS}s `);
    }
    ffmpeg.stdin.end();
    const [code] = await finished;
    if (code !== 0) throw new Error(`ffmpeg stopped with status ${code}`);
    if (errors.length) throw new Error("The page threw: " + errors.join(" | "));
    process.stdout.write(`\nWrote ${video} (${frames} frames at ${FPS} fps)\n`);
    cdp.close();
  } finally {
    chrome.kill();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
