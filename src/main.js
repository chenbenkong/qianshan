import { VERT, FRAG } from "./shader.js";

const canvas = document.getElementById("scene");
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

const vao = gl.createVertexArray();
gl.bindVertexArray(vao);

const uniforms = {};
for (const name of ["uRes", "uTime", "uPointer", "uTravel", "uReveal", "uSteps"]) {
  uniforms[name] = gl.getUniformLocation(program, name);
}

const pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
let travel = 0;
let targetTravel = 0;
let reveal = 0;

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
let minScale = profile ? profile.scale : 0.55;
let maxScale = profile ? profile.scale : nativeScale;
let minSteps = profile ? profile.steps : 34;
let maxSteps = profile ? profile.steps : 120;
let frameBudget = 16.7;
let introStarted = performance.now();

function resize() {
  const cssWidth = window.innerWidth;
  const cssHeight = window.innerHeight;
  const w = Math.max(1, Math.round(cssWidth * scale));
  const h = Math.max(1, Math.round(cssHeight * scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

window.addEventListener("resize", resize, { passive: true });

window.addEventListener(
  "pointermove",
  (event) => {
    pointer.tx = event.clientX / window.innerWidth;
    pointer.ty = event.clientY / window.innerHeight;
  },
  { passive: true },
);

function readScroll() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  targetTravel = max > 0 ? (window.scrollY / max) * 1 : 0;
}
window.addEventListener("scroll", readScroll, { passive: true });

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let last = performance.now();
let clock = 0;
let smooth = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clock += dt;

  frameBudget += ((dt * 1000) - frameBudget) * 0.06;
  if (frameBudget > 26) {
    if (scale > minScale) {
      scale = Math.max(minScale, scale - 0.06);
      resize();
    } else if (steps > minSteps) {
      steps = Math.max(minSteps, steps - 8);
    }
  } else if (frameBudget < 13) {
    if (steps < maxSteps) {
      steps = Math.min(maxSteps, steps + 2);
    } else if (scale < maxScale) {
      scale = Math.min(maxScale, scale + 0.02);
      resize();
    }
  }

  resize();

  const ease = reduceMotion ? 1 : 1 - Math.pow(0.001, dt);
  pointer.x += (pointer.tx - pointer.x) * ease;
  pointer.y += (pointer.ty - pointer.y) * ease;
  smooth += (targetTravel - smooth) * (reduceMotion ? 1 : 1 - Math.pow(0.004, dt));

  travel = smooth * 165.0;
  reveal = reduceMotion ? 1 : Math.min(1, (now - introStarted) / 3400);

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.uniform2f(uniforms.uRes, canvas.width, canvas.height);
  gl.uniform1f(uniforms.uTime, clock);
  gl.uniform2f(uniforms.uPointer, pointer.x, pointer.y);
  gl.uniform1f(uniforms.uTravel, travel);
  gl.uniform1f(uniforms.uReveal, reveal);
  gl.uniform1f(uniforms.uSteps, steps);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  if (reveal >= 1) document.body.classList.add("revealed");
  requestAnimationFrame(frame);
}

resize();
readScroll();
requestAnimationFrame(frame);

const progress = document.querySelector(".scroll-progress__bar");
function paintProgress() {
  if (progress) progress.style.transform = `scaleX(${targetTravel})`;
}
window.addEventListener("scroll", paintProgress, { passive: true });
paintProgress();

const verses = Array.from(document.querySelectorAll("[data-verse]"));
if ("IntersectionObserver" in window && !reduceMotion) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        entry.target.classList.toggle("is-visible", entry.isIntersecting);
      }
    },
    { threshold: 0.35 },
  );
  for (const verse of verses) observer.observe(verse);
} else {
  for (const verse of verses) verse.classList.add("is-visible");
}

document.getElementById("scroll-cue")?.addEventListener("click", () => {
  window.scrollTo({ top: window.innerHeight * 0.9, behavior: "smooth" });
});