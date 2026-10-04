import { VERT, FRAG } from "./shader.js";
import { createScore } from "./audio.js";
import { terrainH } from "./field.js";
import { COUPLETS } from "./verses.js";

const canvas = document.getElementById("scene");
const spacer = document.getElementById("scroll-spacer");
const odoOut = document.getElementById("odo");
const inscription = document.getElementById("inscription");

const gl = canvas.getContext("webgl2", {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  powerPreference: "high-performance",
  preserveDrawingBuffer: false,
});

if (!gl) {
  document.getElementById("fallback").hidden = false;
  throw new Error("WebGL2 unavailable");
}

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    const numbered = source
      .split("\n")
      .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
      .join("\n");
    throw new Error(`shader compile failed\n${log}\n${numbered}`);
  }
  return shader;
}

const program = gl.createProgram();
gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
  throw new Error(`link failed: ${gl.getProgramInfoLog(program)}`);
}
gl.useProgram(program);
gl.bindVertexArray(gl.createVertexArray());

const uniforms = {};
for (const name of [
  "uRes", "uTime", "uCamPos", "uCamRight", "uCamUp", "uCamFwd",
  "uSpeed", "uReveal", "uSteps", "uFar",
]) {
  uniforms[name] = gl.getUniformLocation(program, name);
}

const dpr = window.devicePixelRatio || 1;
const forced = new URLSearchParams(location.search).get("q");
const PROFILES = {
  high: { steps: 220, budget: 4.0e6 },
  medium: { steps: 150, budget: 2.2e6 },
  low: { steps: 84, budget: 0.8e6 },
};
const profile = PROFILES[forced] || { steps: 190, budget: 2.4e6 };

/**
 * Steps are a quality knob here, not a throttle.
 *
 * Measured on the target iGPU at a fixed resolution, 62 / 116 / 150 steps all ran at the
 * same frame rate — the cost is per-pixel work unrelated to step count. So the floor sits
 * at 80% of the profile: low step counts do not buy frames, but they do destroy the image,
 * because rays grazing along a hillside cannot converge and overshoot whole ridges.
 */
const FLOOR_STEPS = Math.round(profile.steps * 0.8);
let steps = profile.steps;
const maxSteps = profile.steps;
let budget = profile.budget;
let minScale = 0.45;
let frameBudget = 16.7;

const pinned = Number(new URLSearchParams(location.search).get("px"));
if (pinned > 0) {
  budget = pinned;
  minScale = 1;
}

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function ceiling() {
  return Math.max(
    minScale,
    Math.min(dpr * 1.25, Math.sqrt(budget / Math.max(1, window.innerWidth * window.innerHeight))),
  );
}

let scale = 1;

function resize() {
  const w = Math.max(1, Math.round(window.innerWidth * scale));
  const h = Math.max(1, Math.round(window.innerHeight * scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

window.addEventListener("resize", () => {
  scale = Math.min(scale, ceiling());
  resize();
}, { passive: true });

/* ── 无限行旅 ─────────────────────────────────── */

/**
 * The scrollbar is not a position, it is a throttle.
 *
 * The page is a six-screen spacer. Scrolling accumulates the delta into `virtual`, then
 * the scroll position is snapped back to the middle. Because the shader and the odometer
 * both read `virtual`, the snap is invisible — the bar sits still while the mountains
 * keep going.
 */
let scrollSpan = 1;
let virtual = 0;
let lastY = 0;
let travel = 0;

function layout() {
  scrollSpan = Math.max(1, window.innerHeight * 6);
  spacer.style.height = `${scrollSpan}px`;
  lastY = window.scrollY;
}

function center() {
  const mid = scrollSpan * 0.5;
  window.scrollTo(0, mid);
  lastY = mid;
}

function onScroll() {
  const y = window.scrollY;
  virtual += y - lastY;
  lastY = y;
  if (virtual < 0) virtual = 0;
  if (y < scrollSpan * 0.2 || y > scrollSpan * 0.8) center();
}

window.addEventListener("scroll", onScroll, { passive: true });

/* ── 镜头 ─────────────────────────────────────── */

const cam = { x: 0, y: 30, z: 0 };
const basis = { fwd: { x: 0, y: 0, z: -1 }, right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } };

/**
 * Routes the camera along bays and shorelines instead of into headlands.
 *
 * A low camera gives the composition that works — horizon in the lower third, peaks
 * towering, mist pooling in the valleys — but a straight -z path ploughs into a range
 * every so often and fills the frame with rock. Rather than climb above the terrain (which
 * puts the eye over the cloud deck, so everything reads as white), the route is steered
 * laterally toward whichever side has lower ground ahead. The corridor average is sampled
 * over a 700-unit lookahead, so the decision is made well before the obstruction.
 */
function corridor(x, z) {
  let sum = 0;
  for (let d = 100; d <= 700; d += 100) sum += terrainH(x, z - d);
  return sum / 7;
}

let guideX = 0;

function placeCamera(clock, dt) {
  const bobY = Math.sin(clock * 0.21) * 0.5 + Math.sin(clock * 0.083) * 0.9;
  const bobX = Math.sin(clock * 0.147) * 0.8;

  cam.z = -travel;

  const left = corridor(cam.x - 95, cam.z);
  const right = corridor(cam.x + 95, cam.z);
  const bias = Math.max(-1, Math.min(1, (left - right) / 26));
  guideX += bias * 34 * dt - guideX * 0.05 * dt;
  guideX = Math.max(-190, Math.min(190, guideX));

  cam.x = guideX + bobX;
  cam.y = 17 + Math.sin(travel * 0.0052) * 6 + bobY;

  const floor = terrainH(cam.x, cam.z) + 7.0;
  if (cam.y < floor) cam.y = floor;

  const yaw = Math.sin(travel * 0.0037) * 0.15 + Math.sin(clock * 0.043) * 0.045;
  const pitch = 0.075 + Math.sin(travel * 0.0043) * 0.04 + Math.sin(clock * 0.031) * 0.010;

  const cp = Math.cos(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);

  basis.fwd.x = sy * cp;
  basis.fwd.y = Math.sin(pitch);
  basis.fwd.z = -cy * cp;
  basis.right.x = cy;
  basis.right.y = 0;
  basis.right.z = sy;
  basis.up.x = basis.right.y * basis.fwd.z - basis.right.z * basis.fwd.y;
  basis.up.y = basis.right.z * basis.fwd.x - basis.right.x * basis.fwd.z;
  basis.up.z = basis.right.x * basis.fwd.y - basis.right.y * basis.fwd.x;
}

/* ── 里程与题字 ───────────────────────────────── */

let lastOdo = -1;
let lastVerse = -1;

function refreshReadouts(speed) {
  const odo = Math.floor(travel * 0.5);
  if (odo !== lastOdo) {
    lastOdo = odo;
    odoOut.textContent = odo.toLocaleString("en-US");
  }
  const vi = Math.floor(travel / 620);
  if (vi !== lastVerse) {
    lastVerse = vi;
    const c = COUPLETS[vi % COUPLETS.length];
    inscription.querySelector(".inscription__line").textContent = c[0] + c[1];
    inscription.querySelector(".inscription__src").textContent = c[2];
    inscription.classList.remove("is-in");
    void inscription.offsetWidth;
    inscription.classList.add("is-in");
  }
  canvas.style.setProperty("--bob", Math.min(1, speed / 90).toFixed(3));
}

/* ── 乐声 ─────────────────────────────────────── */

const score = createScore();
const audioButton = document.getElementById("audio-toggle");

function paintAudio(on) {
  audioButton.setAttribute("aria-pressed", String(on));
  audioButton.setAttribute("aria-label", on ? "关闭乐声" : "开启乐声");
  audioButton.classList.toggle("is-on", on);
}

async function turnOn() {
  const ok = await score.enable();
  if (ok) {
    try { localStorage.setItem("qianshan-audio", "on"); } catch {}
  }
  paintAudio(ok);
}

function turnOff() {
  score.disable();
  try { localStorage.setItem("qianshan-audio", "off"); } catch {}
  paintAudio(false);
}

audioButton.addEventListener("click", (e) => {
  e.stopPropagation();
  if (score.playing) turnOff();
  else turnOn();
});

let stored = null;
try { stored = localStorage.getItem("qianshan-audio"); } catch {}

if (stored !== "off") {
  const arm = () => {
    turnOn();
    for (const type of ["pointerdown", "keydown", "touchstart"]) {
      window.removeEventListener(type, arm);
    }
  };
  for (const type of ["pointerdown", "keydown", "touchstart"]) {
    window.addEventListener(type, arm, { passive: true });
  }
}

/* ── 主循环 ───────────────────────────────────── */

const introStarted = performance.now();
let last = performance.now();
let clock = 0;
let speed = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clock += dt;

  frameBudget += (dt * 1000 - frameBudget) * 0.06;
  if (frameBudget > 26) {
    if (steps > FLOOR_STEPS) steps = Math.max(FLOOR_STEPS, steps - 6);
    if (scale > minScale) {
      scale = Math.max(minScale, scale - 0.03);
      resize();
    }
  } else if (frameBudget < 13) {
    if (scale < ceiling()) {
      scale = Math.min(ceiling(), scale + 0.02);
      resize();
    } else if (steps < maxSteps) {
      steps = Math.min(maxSteps, steps + 2);
    }
  }

  const target = virtual * 0.55;
  const before = travel;
  travel += (target - travel) * (reduceMotion ? 1 : 1 - Math.pow(0.0022, dt));
  speed = Math.abs(travel - before) / Math.max(dt, 1e-4);

  placeCamera(clock, dt);

  const reveal = reduceMotion ? 1 : Math.min(1, (now - introStarted) / 3400);

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.uniform2f(uniforms.uRes, canvas.width, canvas.height);
  gl.uniform1f(uniforms.uTime, clock);
  gl.uniform3f(uniforms.uCamPos, cam.x, cam.y, cam.z);
  gl.uniform3f(uniforms.uCamRight, basis.right.x, basis.right.y, basis.right.z);
  gl.uniform3f(uniforms.uCamUp, basis.up.x, basis.up.y, basis.up.z);
  gl.uniform3f(uniforms.uCamFwd, basis.fwd.x, basis.fwd.y, basis.fwd.z);
  gl.uniform1f(uniforms.uSpeed, speed);
  gl.uniform1f(uniforms.uReveal, reveal);
  gl.uniform1f(uniforms.uSteps, steps);
  gl.uniform1f(uniforms.uFar, 380 + Math.min(cam.y, 240) * 3.2);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  if (reveal >= 1 && !document.body.classList.contains("revealed")) {
    document.body.classList.add("revealed");
  }


  refreshReadouts(speed);
  if (score.playing) score.setElevation(Math.max(0, Math.min(1, (cam.y - 20) / 320)));

  requestAnimationFrame(frame);
}

layout();
scale = ceiling() * 0.7;
resize();
virtual = 0;
center();
refreshReadouts(0);
requestAnimationFrame(frame);

document.getElementById("scroll-cue")?.addEventListener("click", () => {
  window.scrollBy({ top: window.innerHeight * 0.9, behavior: "smooth" });
});