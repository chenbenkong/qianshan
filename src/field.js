function fract(x) {
  return x - Math.floor(x);
}

function hash21(px, py) {
  let x = fract(px * 127.1);
  let y = fract(py * 311.7);
  const d = x * x + y * y + x * 34.53 + y * 34.53;
  x = fract(x + d);
  y = fract(y + d);
  return fract(x * y);
}

function vnoise(px, py) {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  let fx = fract(px);
  let fy = fract(py);
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash21(ix, iy);
  const b = hash21(ix + 1, iy);
  const c = hash21(ix, iy + 1);
  const d = hash21(ix + 1, iy + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

function fbm2(px, py) {
  return (vnoise(px, py) * 0.5 + vnoise(px * 2.03 + 11.7, py * 2.03 + 11.7) * 0.25) / 0.75;
}

function ridged3(px, py, sharp) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let weight = 1;
  for (let i = 0; i < 3; i++) {
    let n = 1 - Math.abs(vnoise(px * freq, py * freq) * 2 - 1);
    n = Math.pow(n, sharp);
    sum += n * amp * weight;
    weight = Math.min(1, Math.max(0, n * weight * 1.4));
    freq *= 2.11;
    amp *= 0.5;
  }
  return sum;
}

/**
 * Terrain height at a world position.
 *
 * This is a faithful transcription of terrainH() in src/shader.js and must stay in sync
 * with it — the flight camera clamps against this to keep from tunnelling into a
 * mountainside. If the two ever disagree, the failure mode is cosmetic (the camera
 * clips a ridge) rather than fatal, but the parameters below are not free to differ.
 */
export function terrainH(x, z) {
  return (
    ridged3(x * 0.0055 + 37.2, z * 0.0055 + 11.9, 2.3) * 150.0 +
    ridged3(x * 0.018 + -8.4, z * 0.018 + 5.1, 1.6) * 26.0 +
    fbm2(x * 0.004 + 90.3, z * 0.004 - 44.7) * 8.0 +
    vnoise(x * 0.33, z * 0.33) * 1.1 -
    38.0
  );
}

export const WATER_LEVEL = 0;