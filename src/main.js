import { VERT, FLOW, SIM, DRAW } from "./shader.js";
import { createScore } from "./audio.js";
import { COUPLETS } from "./verses.js";
import { makePainting, clamp } from "./strokes.js";

const canvas = document.getElementById("scene");
const spacer = document.getElementById("scroll-spacer");
const odoOut = document.getElementById("odo");
const inscription = document.getElementById("inscription");

const gl = canvas.getContext("webgl2", {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
});

if (!gl) {
  document.getElementById("fallback").hidden = false;
  throw new Error("WebGL2 unavailable");
}

const floatRender = !!gl.getExtension("EXT_color_buffer_float");
const stateFormat = floatRender ? gl.RGBA16F : gl.RGBA8;
const stateType = floatRender ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const numbered = source
      .split("\n")
      .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
      .join("\n");
    throw new Error(`compile failed\n${gl.getShaderInfoLog(shader)}\n${numbered}`);
  }
  return shader;
}

function link(fragSource) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSource));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

const progFlow = link(FLOW);
const progSim = link(SIM);
const progDraw = link(DRAW);
const vao = gl.createVertexArray();
gl.bindVertexArray(vao);

const uni = (prog, names) => {
  const out = {};
  for (const n of names) out[n] = gl.getUniformLocation(prog, n);
  return out;
};

const uFlow = uni(progFlow, ["uTime", "uScale"]);
const uSim = uni(progSim, [
  "uPrev", "uFlow", "uTexel", "uAspect", "uDt", "uTime",
  "uWash", "uCount", "uStamp[0]", "uStampDir[0]",
]);
const uDraw = uni(progDraw, ["uState", "uRes", "uTime", "uIntro"]);

const FLOW_RES = 176;
const flowTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, flowTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, FLOW_RES, FLOW_RES, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
const flowFbo = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, flowFbo);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, flowTex, 0);

function makeStateTarget() {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, stateFormat, 2, 2, 0, gl.RGBA, stateType, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.viewport(0, 0, 2, 2);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return { tex, fbo };
}

let state = [makeStateTarget(), makeStateTarget()];
let front = 0;

let simW = 2;
let simH = 2;
let simScale = 0.5;
let renderScale = Math.min(window.devicePixelRatio || 1, 1.4);

function sizeTargets() {
  const w = Math.max(2, Math.round(window.innerWidth * simScale));
  const h = Math.max(2, Math.round(window.innerHeight * simScale));
  if (w === simW && h === simH) return;
  simW = w;
  simH = h;
  for (const s of state) {
    gl.bindTexture(gl.TEXTURE_2D, s.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, stateFormat, w, h, 0, gl.RGBA, stateType, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}

function drawFullscreen() {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function resize() {
  const w = Math.max(1, Math.round(window.innerWidth * renderScale));
  const h = Math.max(1, Math.round(window.innerHeight * renderScale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  sizeTargets();
}

window.addEventListener("resize", resize, { passive: true });

/* ── 时间与画卷 ───────────────────────────────── */

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let scrollSpan = 1;
let virtual = 0;
let lastY = 0;
let velocity = 0;
let smoothBoost = 0;
let clock = 0;
let reveal = 0;
let odometer = 0;

function layout() {
  scrollSpan = Math.max(1, window.innerHeight * 6);
  spacer.style.height = `${scrollSpan}px`;
  lastY = window.scrollY;
}

function centerScroll() {
  const mid = scrollSpan * 0.5;
  window.scrollTo(0, mid);
  lastY = mid;
}

window.addEventListener("scroll", () => {
  const y = window.scrollY;
  const delta = y - lastY;
  lastY = y;
  velocity = clamp(velocity * 0.72 + Math.abs(delta) * 0.5, 0, 260);
  if (delta < 0) virtual = Math.max(0, virtual + delta);
  else virtual += delta;
  if (y < scrollSpan * 0.2 || y > scrollSpan * 0.8) centerScroll();
}, { passive: true });

let painting = makePainting(20260917);
let genStart = 0;
let genIndex = 0;
let wash = 0;
let wiping = false;

function advanceGeneration(now) {
  genIndex++;
  painting = makePainting(1000 + genIndex * 7919);
  genStart = now;
  wiping = false;
  wash = 0;
}

/* ── 题字 ─────────────────────────────────────── */

let lastOdo = -1;
let lastVerse = -1;

function refreshReadouts() {
  const odo = Math.floor(odometer);
  if (odo !== lastOdo) {
    lastOdo = odo;
    odoOut.textContent = odo.toLocaleString("en-US");
  }
  const vi = Math.floor(odometer / 620);
  if (vi !== lastVerse) {
    lastVerse = vi;
    const c = COUPLETS[vi % COUPLETS.length];
    inscription.querySelector(".inscription__line").textContent = c[0] + c[1];
    inscription.querySelector(".inscription__src").textContent = c[2];
    inscription.classList.remove("is-in");
    void inscription.offsetWidth;
    inscription.classList.add("is-in");
  }
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

audioButton.addEventListener("click", (e) => {
  e.stopPropagation();
  if (score.playing) {
    score.disable();
    try { localStorage.setItem("qianshan-audio", "off"); } catch {}
    paintAudio(false);
  } else {
    turnOn();
  }
});

try {
  if (localStorage.getItem("qianshan-audio") === "off") paintAudio(false);
} catch {}

document.getElementById("grind")?.addEventListener("click", (e) => {
  e.stopPropagation();
  wiping = true;
});

/* ── 主循环 ───────────────────────────────────── */

const MAX_STAMPS = 6;
const stampData = new Float32Array(MAX_STAMPS * 4);
const stampDir = new Float32Array(MAX_STAMPS * 4);
const scratch = { x: 0, y: 0, w: 0, press: 0, dry: 0, load: 0.04 };
const ahead = { x: 0, y: 0, w: 0, press: 0, dry: 0, load: 0.04 };

let last = performance.now();
let frameAvg = 16.7;

function frame(now) {
  const raw = (now - last) / 1000;
  last = now;
  const dt = Math.min(0.05, raw);
  frameAvg += (raw * 1000 - frameAvg) * 0.08;

  if (frameAvg > 34 && simScale > 0.3) {
    simScale = Math.max(0.3, simScale - 0.05);
    sizeTargets();
  }

  velocity *= Math.pow(0.02, dt);
  const targetBoost = reduceMotion ? 0 : clamp(velocity / 45, 0, 3.4);
  smoothBoost += (targetBoost - smoothBoost) * (1 - Math.pow(0.02, dt));

  const simDt = dt * (1 + smoothBoost);
  clock += simDt;
  odometer += simDt * 7.2;
  reveal = reduceMotion ? 1 : Math.min(1, reveal + dt / 3.0);

  if (reveal >= 1 && !document.body.classList.contains("revealed")) {
    document.body.classList.add("revealed");
  }

  const local = clock - genStart;

  if (!wiping && local > painting.span + 3.2) wiping = true;

  let count = 0;
  if (!wiping) {
    for (const s of painting.strokes) {
      if (count >= MAX_STAMPS) break;
      if (local < s.t0 || local > s.t0 + s.dur) continue;
      const u = (local - s.t0) / s.dur;
      s.point(u, scratch);
      s.point(Math.min(1, u + 0.03), ahead);
      let dx = ahead.x - scratch.x;
      let dy = ahead.y - scratch.y;
      const dl = Math.hypot(dx, dy);
      if (dl < 1.0e-5) {
        dx = 1;
        dy = 0;
      } else {
        dx /= dl;
        dy /= dl;
      }
      const px = scratch.x + (count % 2 === 0 ? -0.0016 : 0.0016);
      const py = scratch.y + (count % 3 === 0 ? 0.0012 : 0);
      stampData[count * 4 + 0] = px;
      stampData[count * 4 + 1] = 1 - py;
      stampData[count * 4 + 2] = scratch.w;
      stampData[count * 4 + 3] = scratch.press * scratch.load;
      stampDir[count * 4 + 0] = dx;
      stampDir[count * 4 + 1] = -dy;
      stampDir[count * 4 + 2] = scratch.dry;
      stampDir[count * 4 + 3] = s.kind === "wash" ? 1.5 : 3.4;
      count++;
    }
  }

  if (wiping) {
    wash = Math.min(1, wash + dt * 0.55);
    if (wash >= 1) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, state[front].fbo);
      gl.viewport(0, 0, simW, simH);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, state[1 - front].fbo);
      gl.viewport(0, 0, simW, simH);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      advanceGeneration(clock);
    }
  }

  const aspect = Math.max(simW / simH, 1);

  gl.disable(gl.BLEND);

  gl.bindFramebuffer(gl.FRAMEBUFFER, flowFbo);
  gl.viewport(0, 0, FLOW_RES, FLOW_RES);
  gl.useProgram(progFlow);
  gl.uniform1f(uFlow.uTime, clock);
  gl.uniform2f(uFlow.uScale, aspect * 1.9, 1.9);
  drawFullscreen();

  gl.bindFramebuffer(gl.FRAMEBUFFER, state[1 - front].fbo);
  gl.viewport(0, 0, simW, simH);
  gl.useProgram(progSim);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state[front].tex);
  gl.uniform1i(uSim.uPrev, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, flowTex);
  gl.uniform1i(uSim.uFlow, 1);
  gl.uniform2f(uSim.uTexel, 1 / simW, 1 / simH);
  gl.uniform2f(uSim.uAspect, aspect, 1);
  gl.uniform1f(uSim.uDt, Math.min(simDt, 0.05));
  gl.uniform1f(uSim.uTime, clock);
  gl.uniform1f(uSim.uWash, wash);
  gl.uniform1i(uSim.uCount, count);
  gl.uniform4fv(uSim["uStamp[0]"], stampData);
  gl.uniform4fv(uSim["uStampDir[0]"], stampDir);
  drawFullscreen();
  front = 1 - front;

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(progDraw);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state[front].tex);
  gl.uniform1i(uDraw.uState, 0);
  gl.uniform2f(uDraw.uRes, canvas.width, canvas.height);
  gl.uniform1f(uDraw.uTime, clock);
  gl.uniform1f(uDraw.uIntro, reveal);
  drawFullscreen();

  if (score.playing) score.setElevation(clamp(0.5 + 0.5 * Math.sin(clock * 0.05), 0, 1));

  refreshReadouts();
  window.__dbg = {
    clock: clock.toFixed(2),
    local: local.toFixed(2),
    span: painting.span.toFixed(2),
    count,
    kinds: painting.strokes.filter((s) => local >= s.t0 && local <= s.t0 + s.dur).map((s) => s.kind),
    wipe: wiping,
    wash: wash.toFixed(2),
    sim: `${simW}x${simH}`,
  };
  requestAnimationFrame(frame);
}

layout();
resize();
virtual = 0;
centerScroll();
genStart = 0;
requestAnimationFrame(frame);