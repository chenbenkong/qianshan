import { VERT, FRAG } from "./shader.js";
import { createScore } from "./audio.js";
import { terrainH } from "./field.js";
import { COUPLETS } from "./verses.js";

const canvas = document.getElementById("scene");
const hint = document.getElementById("hint");
const crosshair = document.getElementById("crosshair");
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

const nativeScale = Math.min(window.devicePixelRatio || 1, 1.5);
const forced = new URLSearchParams(location.search).get("q");
const PROFILES = {
  high: { steps: 150, scale: Math.min(nativeScale, 2) },
  medium: { steps: 96, scale: nativeScale },
  low: { steps: 44, scale: Math.min(nativeScale, 0.8) },
};
const profile = PROFILES[forced] || null;

let scale = profile ? profile.scale : nativeScale;
let steps = profile ? profile.steps : 120;
const minScale = profile ? profile.scale : 0.55;
const maxScale = profile ? profile.scale : nativeScale;
const minSteps = profile ? profile.steps : 34;
const maxSteps = profile ? profile.steps : 120;
let frameBudget = 16.7;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function resize() {
  const w = Math.max(1, Math.round(window.innerWidth * scale));
  const h = Math.max(1, Math.round(window.innerHeight * scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}
window.addEventListener("resize", resize, { passive: true });

/* ── 飞行 ─────────────────────────────────────── */

const cam = { x: 0, y: 46, z: 150, yaw: 0.06, pitch: -0.10 };
const vel = { x: 0, y: 0, z: 0 };
const keys = new Set();
let locked = false;
let lastInput = performance.now();

const CLEARANCE = 3.0;
const FLOOR = 1.6;
const SPEED = 74;
const BOOST = 3.1;

let travelled = 0;
let lastOdo = -1;
let lastVerse = -1;

function markInput() {
  lastInput = performance.now();
}

function basis() {
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const fwd = { x: sy * cp, y: sp, z: -cy * cp };
  const right = { x: cy, y: 0, z: sy };
  const up = {
    x: right.y * fwd.z - right.z * fwd.y,
    y: right.z * fwd.x - right.x * fwd.z,
    z: right.x * fwd.y - right.y * fwd.x,
  };
  return { fwd, right, up };
}

function step(dt, now) {
  const idle = now - lastInput > 2600 && !locked;
  const b = basis();

  const wish = { x: 0, y: 0, z: 0 };
  if (keys.has("KeyW") || keys.has("ArrowUp")) { wish.x += b.fwd.x; wish.y += b.fwd.y; wish.z += b.fwd.z; }
  if (keys.has("KeyS") || keys.has("ArrowDown")) { wish.x -= b.fwd.x; wish.y -= b.fwd.y; wish.z -= b.fwd.z; }
  if (keys.has("KeyD") || keys.has("ArrowRight")) { wish.x += b.right.x; wish.z += b.right.z; }
  if (keys.has("KeyA") || keys.has("ArrowLeft")) { wish.x -= b.right.x; wish.z -= b.right.z; }
  if (keys.has("Space")) wish.y += 1;
  if (keys.has("ShiftLeft") || keys.has("ShiftRight")) wish.y -= 1;

  const mag = Math.hypot(wish.x, wish.y, wish.z);
  const boost = keys.has("Space") || keys.has("ShiftLeft") || keys.has("ShiftRight") ? BOOST : 1;

  if (mag > 0.001) {
    wish.x /= mag; wish.y /= mag; wish.z /= mag;
    const target = SPEED * boost;
    vel.x += wish.x * target * 5.5 * dt;
    vel.y += wish.y * target * 5.5 * dt;
    vel.z += wish.z * target * 5.5 * dt;
  }

  const damp = Math.pow(mag > 0.001 ? 0.42 : 0.02, dt);
  vel.x *= damp; vel.y *= damp; vel.z *= damp;

  if (idle) {
    const drift = reduceMotion ? 0 : 11;
    vel.x += b.fwd.x * drift * dt;
    vel.y += b.fwd.y * drift * dt;
    vel.z += b.fwd.z * drift * dt;
    cam.yaw += Math.sin(now * 0.00006) * 0.00016;
    cam.pitch = Math.sin(now * 0.000041) * 0.035 - 0.02;
    lastInput = now - 1200;
  }

  cam.x += vel.x * dt;
  cam.y += vel.y * dt;
  cam.z += vel.z * dt;

  const RING = 7.5;
  let floor = Math.max(FLOOR, terrainH(cam.x, cam.z) + CLEARANCE);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const h = terrainH(cam.x + Math.cos(a) * RING, cam.z + Math.sin(a) * RING) + CLEARANCE;
    if (h > floor) floor = h;
  }
  if (cam.y < floor) {
    cam.y = floor;
    if (vel.y < 0) vel.y = 0;
  }
  if (cam.y > 240) {
    cam.y = 240;
    if (vel.y > 0) vel.y = 0;
  }
}

canvas.addEventListener("click", () => {
  if (!locked) canvas.requestPointerLock?.();
});

document.addEventListener("pointerlockchange", () => {
  locked = document.pointerLockElement === canvas;
  document.body.classList.toggle("is-locked", locked);
  crosshair.hidden = !locked;
  if (locked) {
    markInput();
    hint.classList.add("is-gone");
  }
});

document.addEventListener("mousemove", (e) => {
  if (!locked) return;
  const sens = 0.0022;
  cam.yaw += e.movementX * sens;
  cam.pitch -= e.movementY * sens;
  cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch));
  markInput();
});

window.addEventListener("keydown", (e) => {
  if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
    e.preventDefault();
  }
  keys.add(e.code);
  markInput();
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => keys.clear());

let touchLook = null;
let touchYaw = 0;
let touchPitch = 0;
canvas.addEventListener(
  "touchstart",
  (e) => {
    touchLook = { id: e.changedTouches[0].identifier, x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    touchYaw = cam.yaw;
    touchPitch = cam.pitch;
    hint.classList.add("is-gone");
    markInput();
  },
  { passive: true },
);
canvas.addEventListener(
  "touchmove",
  (e) => {
    if (!touchLook) return;
    const t = Array.from(e.changedTouches).find((x) => x.identifier === touchLook.id);
    if (!t) return;
    cam.yaw = touchYaw + (t.clientX - touchLook.x) * 0.005;
    cam.pitch = Math.max(-1.45, Math.min(1.45, touchPitch - (t.clientY - touchLook.y) * 0.005));
    markInput();
  },
  { passive: true },
);
canvas.addEventListener("touchend", () => { touchLook = null; }, { passive: true });

/* ── 里程与题字 ───────────────────────────────── */

function refreshReadouts(speed) {
  const odo = Math.floor(travelled * 0.5);
  if (odo !== lastOdo) {
    lastOdo = odo;
    odoOut.textContent = odo.toLocaleString("en-US");
  }
  const vi = Math.floor(travelled / 620);
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

/* ── 乐声 ─────────────────────────────────────── */

const introStarted = performance.now();
let last = performance.now();
let clock = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clock += dt;

  frameBudget += (dt * 1000 - frameBudget) * 0.06;
  if (frameBudget > 26) {
    if (scale > minScale) {
      scale = Math.max(minScale, scale - 0.06);
      resize();
    } else if (steps > minSteps) {
      steps = Math.max(minSteps, steps - 8);
    }
  } else if (frameBudget < 13) {
    if (steps < maxSteps) steps = Math.min(maxSteps, steps + 2);
    else if (scale < maxScale) {
      scale = Math.min(maxScale, scale + 0.02);
      resize();
    }
  }

  step(dt, now);

  const speed = Math.hypot(vel.x, vel.y, vel.z);
  travelled += speed * dt;

  const b = basis();
  const reveal = reduceMotion ? 1 : Math.min(1, (now - introStarted) / 3400);

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.uniform2f(uniforms.uRes, canvas.width, canvas.height);
  gl.uniform1f(uniforms.uTime, clock);
  gl.uniform3f(uniforms.uCamPos, cam.x, cam.y, cam.z);
  gl.uniform3f(uniforms.uCamRight, b.right.x, b.right.y, b.right.z);
  gl.uniform3f(uniforms.uCamUp, b.up.x, b.up.y, b.up.z);
  gl.uniform3f(uniforms.uCamFwd, b.fwd.x, b.fwd.y, b.fwd.z);
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

resize();
refreshReadouts(0);
requestAnimationFrame(frame);