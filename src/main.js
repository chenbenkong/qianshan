import { VERT, FRAG } from "./shader.js";
import { createScore } from "./audio.js";
import { COUPLETS, STRIDE, SLOTS } from "./verses.js";

const canvas = document.getElementById("scene");
const spacer = document.getElementById("scroll-spacer");
const verseLayer = document.getElementById("verseLayer");
const odoOut = document.getElementById("odo");

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
for (const name of ["uRes", "uTime", "uPointer", "uTravel", "uReveal", "uSteps"]) {
  uniforms[name] = gl.getUniformLocation(program, name);
}

const pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let travel = 0;
let virtual = 0;
let lastY = 0;
let reveal = 0;
let scrollSpan = 1;
let segment = 1;
let odometer = 0;

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

const introStarted = performance.now();

function resize() {
  const w = Math.max(1, Math.round(window.innerWidth * scale));
  const h = Math.max(1, Math.round(window.innerHeight * scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function layout() {
  scrollSpan = Math.max(1, window.innerHeight * 6);
  spacer.style.height = `${scrollSpan}px`;
  segment = Math.max(1, window.innerHeight * 1.25);
  lastY = window.scrollY;
}

const slots = [];
for (let i = 0; i < SLOTS; i++) {
  const el = document.createElement("article");
  el.className = "verse";
  el.innerHTML = `<p class="verse__zh"><span></span><br><span></span></p><cite class="verse__src"></cite>`;
  verseLayer.appendChild(el);
  slots.push({
    el,
    lineA: el.querySelector(".verse__zh span:nth-of-type(1)"),
    lineB: el.querySelector(".verse__zh span:nth-of-type(2)"),
    src: el.querySelector(".verse__src"),
    idx: null,
  });
}

function fill(slot, idx) {
  if (idx <= 0) {
    slot.lineA.textContent = "千山鸟飞绝，";
    slot.lineB.textContent = "独钓寒江雪。";
    slot.src.textContent = "柳宗元 · 江雪";
  } else {
    const c = COUPLETS[(((idx * STRIDE) % COUPLETS.length) + COUPLETS.length) % COUPLETS.length];
    slot.lineA.textContent = c[0];
    slot.lineB.textContent = c[1];
    slot.src.textContent = c[2];
  }
  slot.el.classList.toggle("verse--right", idx % 2 === 1);
}

function placeVerses() {
  const vh = window.innerHeight;
  const first = Math.floor((virtual - vh * 0.9) / segment);
  for (let k = 0; k < slots.length; k++) {
    const slot = slots[k];
    const idx = first + k;
    const y = idx * segment - virtual + vh * 0.5;
    slot.el.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0)`;
    const t = 1 - Math.min(1, Math.abs(y - vh * 0.5) / (vh * 0.66));
    slot.el.style.opacity = (t * t * (3 - 2 * t)).toFixed(3);
    if (slot.idx !== idx) {
      slot.idx = idx;
      fill(slot, idx);
    }
  }
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

  placeVerses();
  const odo = Math.floor(travel * 0.5);
  if (odo !== odometer) {
    odometer = odo;
    odoOut.textContent = odo.toLocaleString("en-US");
  }
}

window.addEventListener("scroll", onScroll, { passive: true });

window.addEventListener("resize", () => {
  resize();
  layout();
  placeVerses();
}, { passive: true });

window.addEventListener(
  "pointermove",
  (event) => {
    pointer.tx = event.clientX / window.innerWidth;
    pointer.ty = event.clientY / window.innerHeight;
  },
  { passive: true },
);

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
    try {
      localStorage.setItem("qianshan-audio", "on");
    } catch {}
  }
  paintAudio(ok);
}

function turnOff() {
  score.disable();
  try {
    localStorage.setItem("qianshan-audio", "off");
  } catch {}
  paintAudio(false);
}

audioButton.addEventListener("click", () => {
  if (score.playing) turnOff();
  else turnOn();
});

let stored = null;
try {
  stored = localStorage.getItem("qianshan-audio");
} catch {}

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
} else {
  paintAudio(false);
}

let last = performance.now();
let clock = 0;
let smoothTravel = 0;

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

  const target = virtual * 0.55;
  smoothTravel += (target - smoothTravel) * (reduceMotion ? 1 : 1 - Math.pow(0.002, dt));
  travel = smoothTravel;

  const ease = reduceMotion ? 1 : 1 - Math.pow(0.001, dt);
  pointer.x += (pointer.tx - pointer.x) * ease;
  pointer.y += (pointer.ty - pointer.y) * ease;

  reveal = reduceMotion ? 1 : Math.min(1, (now - introStarted) / 3400);

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.uniform2f(uniforms.uRes, canvas.width, canvas.height);
  gl.uniform1f(uniforms.uTime, clock);
  gl.uniform2f(uniforms.uPointer, pointer.x, pointer.y);
  gl.uniform1f(uniforms.uTravel, travel);
  gl.uniform1f(uniforms.uReveal, reveal);
  gl.uniform1f(uniforms.uSteps, steps);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  if (reveal >= 1 && !document.body.classList.contains("revealed")) {
    document.body.classList.add("revealed");
  }
  if (score.playing) {
    score.setElevation(0.5 + 0.5 * Math.sin(travel * 0.0016));
  }

  requestAnimationFrame(frame);
}

layout();
resize();
virtual = 0;
center();
placeVerses();
requestAnimationFrame(frame);

document.getElementById("scroll-cue")?.addEventListener("click", () => {
  window.scrollBy({ top: window.innerHeight * 0.9, behavior: "smooth" });
});