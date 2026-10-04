export const VERT = `#version 300 es
precision highp float;
const vec2 CORNERS[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() {
  vec2 p = CORNERS[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/**
 * Curl of a slowly drifting noise potential, written to a small texture.
 *
 * Evaluating this per simulation pixel would cost four fbm taps each, so it is baked into
 * a low-resolution field and sampled. Incompressible swirl is what makes ink creep along
 * paper fibres instead of expanding in perfect circles.
 */
export const FLOW = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform float uTime;
uniform vec2 uScale;

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.53);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float potential(vec2 p, float t) {
  return vnoise(p * 1.55 + vec2(t * 0.035, -t * 0.021)) * 0.72
       + vnoise(p * 3.40 - vec2(t * 0.052, t * 0.013)) * 0.28;
}

void main() {
  vec2 p = vUv * uScale;
  float t = uTime;
  const float e = 0.055;
  float a = potential(p + vec2(0.0, e), t);
  float b = potential(p - vec2(0.0, e), t);
  float c = potential(p + vec2(e, 0.0), t);
  float d = potential(p - vec2(e, 0.0), t);
  vec2 curl = vec2(a - b, -(c - d)) / (2.0 * e);
  curl = clamp(curl * 0.42, vec2(-1.0), vec2(1.0));
  fragColor = vec4(curl * 0.5 + 0.5, 0.0, 1.0);
}`;

/**
 * One diffusion step. State is (water, ink) in r/g.
 *
 * The three behaviours that make ink read as ink rather than as a blurred blob:
 * pigment is carried by the flow while the paper is wet but stops once dry; ink bleeds
 * into wet neighbours faster than it diffuses into dry ones; and the wet boundary
 * concentrates pigment into a darker rim — the coffee-ring edge that every real ink
 * wash on damp paper has.
 */
export const SIM = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uPrev;
uniform sampler2D uFlow;
uniform vec2 uTexel;
uniform vec2 uAspect;
uniform float uDt;
uniform float uTime;
uniform float uWash;
uniform int uCount;
uniform vec4 uStamp[6];
uniform vec4 uStampDir[6];

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.53);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec2 uv = vUv;
  vec2 aspect = uAspect;

  float paper = 0.55 + 0.45 * vnoise(uv * vec2(180.0, 150.0));
  float fibre = 0.62 + 0.38 * vnoise(uv * vec2(14.0, 96.0) + 3.1);

  vec2 flow = texture(uFlow, uv).xy * 2.0 - 1.0;
  vec2 src = uv - flow * uDt * 0.0075;

  vec4 c = texture(uPrev, src);
  vec4 l = texture(uPrev, src - vec2(uTexel.x, 0.0));
  vec4 r = texture(uPrev, src + vec2(uTexel.x, 0.0));
  vec4 d = texture(uPrev, src - vec2(0.0, uTexel.y));
  vec4 u = texture(uPrev, src + vec2(0.0, uTexel.y));

  vec4 blur = (c * 2.0 + l + r + d + u) / 6.0;

  float wetness = mix(c.r, blur.r, 0.022 * uDt * 60.0 * paper * fibre);
  float pigment = c.g;

  float wetNeighbours = (l.r + r.r + d.r + u.r) * 0.25;
  float wetnessMix = clamp(wetNeighbours * 2.2, 0.0, 1.0);
  float bleed = mix(0.0007, 0.0038, wetnessMix) * uDt * 60.0 * paper;
  pigment = mix(pigment, blur.g, clamp(bleed, 0.0, 0.6));

  float rim = length(vec2(r.r - l.r, u.r - d.r));
  pigment += rim * 0.030 * uDt * 60.0 * fibre;

  wetness -= uDt * 60.0 * 0.0060 * mix(0.7, 1.25, 1.0 - fibre);
  wetness = max(wetness, 0.0);

  pigment -= uDt * 60.0 * 0.00028 * mix(0.55, 1.0, wetness > 0.02 ? 1.0 : 0.0);
  pigment *= 1.0 - uDt * 60.0 * 0.00016 * uWash;

  for (int i = 0; i < 6; i++) {
    if (i >= uCount) break;
    vec4 s = uStamp[i];
    vec4 sd = uStampDir[i];
    vec2 q = (uv - s.xy) * aspect;

    vec2 dir = sd.xy;
    float dl = length(dir);
    dir = dl > 1.0e-4 ? dir / dl : vec2(1.0, 0.0);
    float along = dot(q, dir);
    float across = dot(q, vec2(-dir.y, dir.x));
    float stretch = max(1.0, sd.w);
    float e = length(vec2(along / stretch, across));
    float body = smoothstep(s.z, s.z * 0.16, e);

    float streak = vnoise(q * 5.2 + dir * 1.4);
    float dry = sd.z;
    float flying = mix(1.0, smoothstep(0.28, 0.76, streak), dry);

    wetness += body * s.w * 1.10 * flying;
    pigment += body * s.w * 1.30 * flying;
  }

  fragColor = vec4(clamp(wetness, 0.0, 2.0), clamp(pigment, 0.0, 2.0), 0.0, 1.0);
}`;

/**
 * Paper plus ink. Ink tone is a saturating curve, not linear alpha, and the hue shifts
 * from warm grey in the pale washes to blue-black in the dense passages — which is how
 * 墨分五色 actually behaves on sized paper.
 */
export const DRAW = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uState;
uniform vec2 uRes;
uniform float uTime;
uniform float uIntro;

const vec3 PAPER = vec3(0.945, 0.929, 0.898);

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.53);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec2 uv = vUv;
  vec2 frag = vUv * uRes;

  float mottle = vnoise(uv * vec2(5.0, 4.0) + 11.0);
  float tooth  = vnoise(uv * vec2(320.0, 260.0));
  float fibre  = vnoise(vec2(frag.x * 0.62, frag.y * 0.045));

  vec3 paper = PAPER;
  paper *= 0.975 + 0.050 * mottle;
  paper *= 0.982 + 0.036 * tooth;
  paper += (fibre - 0.5) * 0.014;

  vec2 s = texture(uState, uv).xy;
  float pigment = s.y;
  float wetness = s.x;

  float tone = 1.0 - exp(-pigment * 2.35);

  vec3 paleInk  = vec3(0.545, 0.545, 0.552);
  vec3 midInk   = vec3(0.223, 0.235, 0.262);
  vec3 deepInk  = vec3(0.055, 0.066, 0.086);
  vec3 ink = mix(paleInk, midInk, smoothstep(0.04, 0.42, tone));
  ink = mix(ink, deepInk, smoothstep(0.40, 0.92, tone));

  vec3 col = mix(paper, ink, tone);

  float granulation = vnoise(uv * 46.0 + 5.0) - 0.5;
  col = mix(col, col * (1.0 + granulation * 0.14), tone * 0.85);

  col = mix(col, paper * 1.012, clamp(wetness, 0.0, 1.0) * 0.20);

  float bloom = smoothstep(0.02, 0.55, pigment);
  col = mix(col, col * vec3(0.985, 0.99, 1.005), bloom * 0.5);

  vec2 q = uv - 0.5;
  col *= 1.0 - dot(q, q) * 0.22;

  col += (hash21(frag + uTime) - 0.5) * 0.010;

  float m = smoothstep(0.0, 0.30, uIntro);
  float front = vnoise(uv * 2.4 + vec2(0.0, -uIntro * 1.4) + 7.3);
  float halo = smoothstep(-0.03, 0.12, uIntro * 2.2 - front * 0.9)
             * (1.0 - smoothstep(0.12, 0.38, uIntro * 2.2 - front * 0.9));
  col = mix(col, vec3(0.08, 0.09, 0.11), clamp(halo, 0.0, 1.0) * 0.30 * step(0.001, uIntro));
  col = mix(paper, col, m);

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;