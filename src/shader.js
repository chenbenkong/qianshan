export const VERT = `#version 300 es
precision highp float;
const vec2 CORNERS[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() {
  vec2 p = CORNERS[gl_VertexID];
  gl_Position = vec4(p, 0.0, 1.0);
}`;

export const FRAG = `#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform vec3  uCamPos;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec3  uCamFwd;
uniform float uSpeed;
uniform float uReveal;
uniform float uSteps;
uniform float uFar;

const vec3  PAPER    = vec3(0.951, 0.937, 0.906);
const vec3  INK      = vec3(0.063, 0.075, 0.094);
const vec3  CINNABAR = vec3(0.639, 0.176, 0.149);
const vec3  MOON_DIR = vec3(0.4320, 0.3071, -0.8487);

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

float fbm2(vec2 p) {
  return (vnoise(p) * 0.5 + vnoise(p * 2.03 + 11.7) * 0.25) / 0.75;
}

float fbm3(vec2 p) {
  return (vnoise(p) * 0.5 + vnoise(p * 2.03 + 11.7) * 0.25
        + vnoise(p * 4.11 + 23.4) * 0.125) / 0.875;
}

float ridged3(vec2 p, float sharp) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  float weight = 1.0;
  for (int i = 0; i < 3; i++) {
    float n = 1.0 - abs(vnoise(p * freq) * 2.0 - 1.0);
    n = pow(n, sharp);
    sum += n * amp * weight;
    weight = clamp(n * weight * 1.4, 0.0, 1.0);
    freq *= 2.11;
    amp *= 0.5;
  }
  return sum;
}

float terrainH(vec2 p) {
  float ranges  = ridged3(p * 0.0055 + vec2(37.2, 11.9), 2.30) * 150.0;
  float spurs   = ridged3(p * 0.0180 + vec2(-8.4, 5.1), 1.60) * 26.0;
  float shelves = fbm2(p * 0.0040 + vec2(90.3, -44.7)) * 8.0;
  float grain   = vnoise(p * 0.33) * 1.1;
  return ranges + spurs + shelves + grain - 38.0;
}

float terrainD(vec3 p) { return p.y - terrainH(p.xz); }

vec3 terrainNormal(vec3 p, float t) {
  float e = max(0.020, t * 0.0040);
  float hx = terrainH(p.xz + vec2(e, 0.0));
  float hz = terrainH(p.xz + vec2(0.0, e));
  return normalize(vec3(p.y - hx, e, p.y - hz));
}

float marchTerrain(vec3 ro, vec3 rd, float tMax, int budget) {
  float t = 0.12;
  for (int i = 0; i < 180; i++) {
    if (i >= budget) break;
    float d = terrainD(ro + rd * t);
    float dt = max(0.0055 * t, d * 0.46);
    if (d < dt * 0.85) return t;
    t += dt;
    if (t > tMax) break;
  }
  return -1.0;
}

float mistDepth(vec3 ro, vec3 rd, float tMax) {
  float acc = 0.0;
  float prev = 0.0;
  for (int i = 1; i <= 20; i++) {
    float f = float(i) / 20.0;
    float t = tMax * f * f;
    float dt = t - prev;
    vec3 p = ro + rd * t;
    float band = 1.0 - smoothstep(6.0, 58.0, p.y);
    float body = fbm3(p.xz * 0.0125 + vec2(uTime * 0.010, uTime * 0.004));
    acc += band * smoothstep(0.26, 0.74, body) * dt;
    prev = t;
  }
  return acc;
}

vec3 skyTone(vec3 rd) {
  float y = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(PAPER, vec3(0.874, 0.886, 0.902), smoothstep(0.50, 1.0, y) * 0.30);

  float disc = dot(rd, MOON_DIR);
  col = mix(col, vec3(0.996, 0.994, 0.982), smoothstep(0.99930, 0.99972, disc));
  col = mix(col, vec3(0.886, 0.888, 0.878), smoothstep(0.99820, 0.99930, disc) * 0.50);

  vec2 cuv = rd.xz / (rd.y + 0.34);
  float wash = fbm3(cuv * 0.115 + vec2(uTime * 0.008, uTime * 0.003));
  float streak = fbm2(cuv * vec2(0.055, 0.20) + vec2(uTime * 0.013, 0.0));
  float above = smoothstep(0.008, 0.16, rd.y);
  float lift = 1.0 - smoothstep(0.26, 0.78, rd.y);

  col = mix(col, INK, smoothstep(0.42, 0.86, wash) * 0.17 * above * lift);
  col = mix(col, INK, smoothstep(0.52, 0.92, streak) * 0.09 * above * lift);
  return col;
}

float inkTone(vec3 p, vec3 n, vec3 rd, float t) {
  float slope = 1.0 - n.y;
  float rock = smoothstep(0.025, 0.30, slope);

  float key = clamp(dot(n, normalize(vec3(-0.42, 0.58, 0.70))) * 0.5 + 0.5, 0.0, 1.0);
  float ink = mix(0.045, 0.740, rock);
  ink *= 0.54 + 0.46 * key;

  vec2 tangent = vec2(-n.z, n.x);
  float tl = length(tangent);
  tangent = tl > 1.0e-3 ? tangent / tl : vec2(1.0, 0.0);
  float along = dot(p.xz, tangent);

  float hemp = fbm3(vec2(along * 0.26, p.y * 0.048));
  ink += (hemp - 0.5) * 0.30 * rock;
  float fine = fbm2(vec2(along * 0.70 + p.y * 0.03, p.y * 0.11));
  ink += (fine - 0.5) * 0.16 * rock;

  float accent = smoothstep(0.70, 0.96, fbm3(vec2(along * 0.12, p.y * 0.026) + 3.1));
  ink += accent * 0.22 * rock;

  float crevice = clamp((terrainH(p.xz + n.xz * 5.0) - p.y) * 0.42, 0.0, 1.0);
  ink *= 1.0 - crevice * 0.40;

  float rim = pow(clamp(1.0 + dot(n, rd), 0.0, 1.0), 3.0);
  ink *= 1.0 - rim * 0.16;

  ink *= 1.0 - smoothstep(60.0, 430.0, t) * 0.66;

  float levels = 6.0;
  float dither = (hash21(gl_FragCoord.xy) - 0.5) * (0.9 / levels);
  ink = mix(ink, floor(clamp(ink, 0.0, 0.999) * levels + 0.5) / levels, 0.20);
  return clamp(ink + dither, 0.0, 1.0);
}

float flockInk(vec3 ro, vec3 rd) {
  float alt = 96.0;
  if (rd.y < 0.015) return 0.0;
  float t = (alt - ro.y) / rd.y;
  if (t <= 0.0 || t > 3000.0) return 0.0;

  float cycle = 41.0;
  float slot = floor(uTime / cycle);
  float local = mod(uTime, cycle) / cycle;
  float strength = smoothstep(0.0, 0.10, local) * (1.0 - smoothstep(0.58, 0.94, local));
  if (strength <= 0.001) return 0.0;

  float dir = mod(slot, 2.0) < 1.0 ? 1.0 : -1.0;
  vec2 centre = vec2(dir * (local - 0.5) * 900.0, 40.0 + slot * 53.0);

  vec2 hit = (ro + rd * t).xz - centre;
  float ink = 0.0;
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float rank = floor(fi * 0.5);
    float side = mod(fi, 2.0) < 0.5 ? -1.0 : 1.0;
    vec2 pos = vec2(-side * rank * 11.0 - dir * rank * 4.0, side * rank * 6.0);
    vec2 q = hit - pos;
    float span = 3.4 + rank * 0.5;
    float u = clamp(q.x / span, -1.0, 1.0);
    float curve = 0.34 * span * (1.0 - u * u)
                + 0.22 * span * sin(uTime * (7.2 - rank * 0.3) + fi * 1.7) * abs(u);
    float d = abs(q.y - curve);
    float th = span * 0.075;
    float body = smoothstep(th, th * 0.18, d) * step(abs(q.x), span);
    ink = max(ink, body);
  }
  return ink * strength;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = (frag - 0.5 * uRes) / uRes.y;

  vec3 ro = uCamPos;
  vec3 rd = normalize(p.x * uCamRight + p.y * uCamUp + 1.25 * uCamFwd);

  float bobAmt = clamp(uSpeed / 90.0, 0.0, 1.0);
  rd = normalize(rd + uCamRight * sin(uTime * 8.4) * 0.0022 * bobAmt
                   + uCamUp * sin(uTime * 13.1) * 0.0016 * bobAmt);

  vec3 col = skyTone(rd);

  float tWater = 1.0e9;
  if (rd.y < -0.0005 && ro.y > 0.0) tWater = -ro.y / rd.y;
  float tLimit = min(uFar, tWater);

  float tHit = marchTerrain(ro, rd, tLimit, int(uSteps));
  float mist = mistDepth(ro, rd, tHit > 0.0 ? tHit : tLimit);

  if (tHit > 0.0) {
    vec3 pos = ro + rd * tHit;
    vec3 nrm = terrainNormal(pos, tHit);
    float ink = inkTone(pos, nrm, rd, tHit);
    float aerial = 1.0 - exp(-tHit * 0.0030);
    float trans = exp(-mist * 0.017) * (1.0 - aerial * 0.62);
    col = mix(col, mix(INK, PAPER, ink), trans);
  }

  if (rd.y < -0.0005 && ro.y > 0.0) {
    vec2 wp = ro.xz + rd.xz * tWater;
    float ripple = fbm3(wp * 0.16 + vec2(uTime * 0.05, uTime * 0.021));
    vec3 rr = normalize(reflect(rd, normalize(vec3(
      (ripple - 0.5) * 0.15, 1.0, (fbm2(wp * 0.12) - 0.5) * 0.11))));

    float rHit = marchTerrain(ro + vec3(0.0, 0.02, 0.0), rr, 240.0, int(uSteps * 0.42));

    vec3 refl = skyTone(rr);
    float rFade = 1.0;
    if (rHit > 0.0) {
      vec3 rp = ro + rr * rHit;
      vec3 rn = terrainNormal(rp, rHit);
      float rInk = inkTone(rp, rn, rr, rHit);
      refl = mix(INK, PAPER, clamp(rInk * 0.94 + 0.06, 0.0, 1.0));
      rFade = 1.0 - smoothstep(40.0, 240.0, rHit) * 0.88;
    }

    float fres = pow(clamp(1.0 + rd.y, 0.0, 1.0), 2.2);
    float near = smoothstep(0.0, 18.0, tWater);
    float mid = smoothstep(18.0, 90.0, tWater);

    float lines = smoothstep(0.93, 1.0, sin(wp.x * 0.030 + fbm3(wp * 0.042) * 3.0));
    lines *= smoothstep(0.50, 0.78, fbm3(wp * vec2(0.014, 0.07) + 7.3));
    lines *= smoothstep(2.5, 40.0, tWater) * (1.0 - smoothstep(70.0, 190.0, tWater) * 0.7);

    float washInk = mix(0.012, 0.155, fres) + lines * 0.20;
    washInk += smoothstep(0.93, 1.0, fbm2(wp * 0.05 + vec2(uTime * 0.02, 0.0))) * 0.035;

    float surfaceInk = clamp(mix(washInk, 0.045 + 0.215 * fres, 0.68) * near
                           + fres * 0.15 * mid, 0.0, 1.0);
    vec3 water = mix(INK, PAPER, 1.0 - surfaceInk);
    water = mix(water, refl, clamp(fres * 0.80 + 0.14, 0.0, 1.0) * rFade);
    water = mix(water, PAPER, (1.0 - exp(-tWater * 0.0021)) * 0.55 + mist * 0.005);
    water = mix(water, skyTone(rd), 1.0 - exp(-tWater * 0.0032));
    col = water;
  }

  col = mix(col, PAPER, clamp(1.0 - exp(-mist * 0.017), 0.0, 1.0) * 0.26);

  col = mix(col, INK, flockInk(ro, rd) * 0.85);

  float front = fbm3(uv * 2.15 + vec2(0.0, -uReveal * 1.35) + 4.7);
  float m = uReveal * 2.25 - front * 0.92;
  float halo = smoothstep(-0.02, 0.14, m) * (1.0 - smoothstep(0.14, 0.40, m));
  col = mix(col, INK, clamp(halo, 0.0, 1.0) * 0.55 * step(0.001, uReveal));
  col = mix(PAPER, col, smoothstep(0.0, 0.26, m));

  float fibre = vnoise(vec2(frag.x * 0.72, frag.y * 0.055)) * 0.020
              + vnoise(vec2(frag.x * 0.048, frag.y * 0.80)) * 0.016;
  col += fibre - 0.018;
  col += (hash21(frag + uTime) - 0.5) * 0.012;

  vec2 q = uv - 0.5;
  col *= 1.0 - dot(q, q) * 0.26;
  col = clamp(col, 0.0, 1.0);

  float inkMask = smoothstep(0.58, 0.0, dot(col, vec3(0.333)));
  fragColor = vec4(mix(col, CINNABAR, inkMask * 0.020), 1.0);
}`;