export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Stroke archetypes.
 *
 * None of these draw anything. Each returns where the brush tip is, how hard it is pressed
 * and how much ink it carries; that gets stamped into the water/pigment field and the
 * simulation does the bleeding. Authoring a path and letting physics render it is the whole
 * trick — a convincing brushstroke cannot be produced by drawing a brushstroke.
 *
 * Every archetype is placed by (cx, cy) with a horizontal half-width `hw`, so a dab can
 * be a small mark in one corner while a ridge spans the sheet.
 */
const KINDS = {
  ridge(u, r, out) {
    const taper = Math.sin(Math.min(1, u * 1.04) * Math.PI);
    out.x = r.cx + (u - 0.5) * 2 * r.hw;
    out.y = r.cy + Math.sin(u * Math.PI * (0.6 + r.wave) + r.phase) * r.bow * r.dir;
    out.w = lerp(0.010, 0.032, r.grain) * (0.30 + taper * 1.0);
    out.press = taper * (0.75 + r.heavy * 0.8);
    out.dry = clamp(0.12 + u * 0.6, 0, 0.88);
    out.load = 0.055;
  },

  peak(u, r, out) {
    const taper = Math.sin(Math.min(1, u * 1.08) * Math.PI);
    out.x = r.cx + (u - 0.5) * 2 * r.hw;
    out.y = r.cy - Math.sin(u * Math.PI) * r.bow;
    out.w = 0.011 + taper * 0.030;
    out.press = taper * (0.85 + r.heavy * 0.9);
    out.dry = clamp(0.08 + u * 0.65, 0, 0.92);
    out.load = 0.085;
  },

  shore(u, r, out) {
    const taper = Math.sin(Math.min(1, u * 1.08) * Math.PI);
    out.x = r.cx + (u - 0.5) * 2 * r.hw;
    out.y = r.cy + Math.sin(u * 9.0 + r.phase) * 0.006;
    out.w = 0.006 + taper * 0.013;
    out.press = taper * 0.6;
    out.dry = 0.55;
    out.load = 0.042;
  },

  wash(u, r, out) {
    out.x = r.cx + (u - 0.5) * 2 * r.hw;
    out.y = r.cy + Math.sin(u * Math.PI * 1.3 + r.phase) * r.bow;
    out.w = r.bow * 1.5 + 0.07;
    out.press = 0.5 * Math.sin(Math.min(1, u * 1.15) * Math.PI);
    out.dry = 0.0;
    out.load = 0.0095;
  },

  bird(u, r, out) {
    out.x = r.cx + (u - 0.5) * 2 * r.hw;
    out.y = r.cy + Math.sin(u * Math.PI) * 0.020;
    out.w = 0.011;
    out.press = Math.sin(Math.min(1, u * 1.15) * Math.PI) * 0.6;
    out.dry = 0.30;
    out.load = 0.060;
  },
};

/**
 * Builds one painting.
 *
 * Placement matters more than anything else here. Screen y runs 0 (top) to 1 (bottom),
 * so the pale distant wash sits high, ridges step down through the middle, and the dark
 * accents cluster low — the same reading order a painter uses, and the reason the
 * composition holds together instead of merging into one mass.
 */
export function makePainting(seed) {
  const rng = makeRng(seed);
  const strokes = [];
  let cursor = 0.15;

  const add = (kind, dur, o = {}) => {
    const r = () => rng();
    r.phase = rng() * Math.PI * 2;
    r.dir = rng() < 0.5 ? -1 : 1;
    r.wave = 0.4 + rng() * 1.1;
    r.grain = rng();
    r.heavy = rng();
    r.cx = o.cx !== undefined ? o.cx : 0.5;
    r.cy = o.cy !== undefined ? o.cy : 0.5;
    r.hw = o.hw !== undefined ? o.hw : 0.55;
    r.bow = o.bow !== undefined ? o.bow : 0.06;
    strokes.push({ kind, t0: cursor, dur, point: (u, out) => KINDS[kind](clamp(u, 0, 1), r, out) });
    cursor += dur + (o.gap !== undefined ? o.gap : 0.14 + rng() * 0.26);
  };

  const washes = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < washes; i++) {
    add("wash", 0.8 + rng() * 0.5, {
      cx: 0.22 + rng() * 0.56,
      cy: 0.16 + rng() * 0.14,
      hw: 0.26 + rng() * 0.18,
      bow: 0.05 + rng() * 0.05,
      gap: 0.08 + rng() * 0.16,
    });
  }

  const ridges = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < ridges; i++) {
    add("ridge", 1.1 + rng() * 0.7, {
      cx: 0.5 + (rng() - 0.5) * 0.24,
      cy: 0.34 + i * 0.11 + rng() * 0.05,
      hw: 0.66 + rng() * 0.22,
      bow: 0.05 + rng() * 0.06,
      gap: 0.08 + rng() * 0.16,
    });
  }

  if (rng() < 0.8) {
    const bx = 0.18 + rng() * 0.6;
    const by = 0.20 + rng() * 0.12;
    add("bird", 0.42 + rng() * 0.22, { cx: bx, cy: by, hw: 0.10, gap: 0.10 });
    if (rng() < 0.65) {
      add("bird", 0.40 + rng() * 0.22, { cx: bx + 0.10, cy: by + 0.05, hw: 0.09, gap: 0.12 });
    }
  }

  const peaks = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < peaks; i++) {
    add("peak", 0.85 + rng() * 0.5, {
      cx: 0.24 + rng() * 0.52,
      cy: 0.56 + rng() * 0.10,
      hw: 0.22 + rng() * 0.18,
      bow: 0.14 + rng() * 0.18,
      gap: 0.08 + rng() * 0.14,
    });
  }

  const clusters = 2 + Math.floor(rng() * 2);
  for (let c = 0; c < clusters; c++) {
    const cx = 0.12 + rng() * 0.76;
    const cy = 0.68 + rng() * 0.20;
    const n = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      add("peak", 0.30 + rng() * 0.22, {
        cx: clamp(cx + (rng() - 0.5) * 0.20, 0.06, 0.94),
        cy: clamp(cy + (rng() - 0.5) * 0.12, 0.60, 0.92),
        hw: 0.055 + rng() * 0.055,
        bow: 0.05 + rng() * 0.07,
        gap: 0.05 + rng() * 0.10,
      });
    }
  }

  if (rng() < 0.8) {
    add("shore", 1.0 + rng() * 0.5, {
      cx: 0.5 + (rng() - 0.5) * 0.2,
      cy: 0.90,
      hw: 0.55 + rng() * 0.2,
      gap: 0.10,
    });
  }

  return { strokes, span: cursor };
}

export { clamp, lerp };