const SCALE = [0, 2, 4, 7, 9];
const BASE_HZ = 146.83;
const LOW_HZ = 73.42;

export function createScore() {
  let ctx = null;
  let master = null;
  let dry = null;
  let wet = null;
  let convolver = null;
  let droneOsc = [];
  let droneFilter = null;
  let droneGain = null;
  let windGain = null;
  let windFilter = null;

  let running = false;
  let muted = false;
  let nextTime = 0;
  let timer = null;
  let phraseLeft = 0;
  let degree = 2;
  let cache = new Map();

  function hz(step) {
    const octave = Math.floor(step / SCALE.length);
    const semis = SCALE[((step % SCALE.length) + SCALE.length) % SCALE.length];
    return BASE_HZ * Math.pow(2, octave + semis / 12);
  }

  function noiseBuffer(seconds) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function impulse(seconds, decay) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
      }
    }
    return buf;
  }

  function pluck(freq, seconds, damping) {
    const key = `${Math.round(freq * 10)}_${seconds}_${damping}`;
    if (cache.has(key)) return cache.get(key);

    const sr = ctx.sampleRate;
    const n = Math.max(1, Math.floor(sr * seconds));
    const buf = ctx.createBuffer(1, n, sr);
    const out = buf.getChannelData(0);

    const line = Math.max(2, Math.round(sr / freq));
    const delay = new Float32Array(line);
    for (let i = 0; i < line; i++) delay[i] = Math.random() * 2 - 1;

    const pick = Math.max(1, Math.floor(line * 0.22));
    for (let i = line - 1; i >= pick; i--) delay[i] -= delay[i - pick] * 0.62;

    let idx = 0;
    for (let i = 0; i < n; i++) {
      const cur = delay[idx];
      const nxt = delay[(idx + 1) % line];
      delay[idx] = damping * 0.5 * (cur + nxt);
      out[i] = cur;
      idx = (idx + 1) % line;
    }

    const fade = Math.min(n, Math.floor(sr * 0.15));
    for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;

    cache.set(key, buf);
    return buf;
  }

  function voice(freq, at, gain, seconds, damping) {
    const src = ctx.createBufferSource();
    src.buffer = pluck(freq, seconds, damping);
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(dry);
    g.connect(wet);
    src.start(at);
    src.stop(at + seconds + 0.05);
  }

  function strike(at) {
    if (phraseLeft <= 0) {
      phraseLeft = 3 + Math.floor(Math.random() * 5);
      degree = Math.floor(Math.random() * 4) - 1;
    }

    const leap = Math.random() < 0.22;
    degree += leap ? (Math.random() < 0.5 ? -4 : 4) : Math.random() < 0.5 ? -1 : 1;
    degree = Math.max(-1, Math.min(SCALE.length * 3 - 1, degree));

    const freq = hz(degree);
    const open = Math.random() < 0.16;
    voice(freq, at, 0.15 + Math.random() * 0.09, open ? 5.4 : 4.2, open ? 0.9975 : 0.9958);

    if (Math.random() < 0.2) {
      voice(freq * 2, at + 0.045, 0.055 + Math.random() * 0.03, 2.6, 0.9930);
    }
    if (Math.random() < 0.1) {
      voice(freq * 3, at + 0.075, 0.03, 1.8, 0.9905);
    }

    phraseLeft--;
  }

  function breath(at) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(2.2);
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 700 + Math.random() * 900;
    f.Q.value = 1.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.02 + Math.random() * 0.016, at + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 2.1);
    src.connect(f);
    f.connect(g);
    g.connect(wet);
    src.start(at);
    src.stop(at + 2.2);
  }

  function pump() {
    if (!running) return;
    const horizon = ctx.currentTime + 0.9;
    while (nextTime < horizon) {
      if (phraseLeft <= 0 && Math.random() < 0.34) {
        breath(nextTime);
        nextTime += 1.4 + Math.random() * 1.8;
      } else {
        strike(nextTime);
        nextTime += 0.62 + Math.random() * 1.15;
      }
    }
  }

  function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    convolver = ctx.createConvolver();
    convolver.buffer = impulse(3.4, 2.6);
    wet = ctx.createGain();
    wet.gain.value = 0.85;
    convolver.connect(wet);
    wet.connect(master);

    dry = ctx.createGain();
    dry.gain.value = 0.55;
    dry.connect(master);

    droneGain = ctx.createGain();
    droneGain.gain.value = 0.075;
    droneFilter = ctx.createBiquadFilter();
    droneFilter.type = "lowpass";
    droneFilter.frequency.value = 320;
    droneFilter.Q.value = 0.6;
    droneGain.connect(droneFilter);
    droneFilter.connect(master);
    droneFilter.connect(convolver);

    for (const [ratio, detune, type] of [[1, 0, "sine"], [1, 6, "sine"], [0.5, -4, "triangle"]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = LOW_HZ * ratio;
      o.detune.value = detune;
      o.connect(droneGain);
      o.start();
      droneOsc.push(o);
    }

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.055;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.030;
    lfo.connect(lfoGain);
    lfoGain.connect(droneGain.gain);
    lfo.start();

    const wind = ctx.createBufferSource();
    wind.buffer = noiseBuffer(5);
    wind.loop = true;
    windFilter = ctx.createBiquadFilter();
    windFilter.type = "bandpass";
    windFilter.frequency.value = 480;
    windFilter.Q.value = 0.55;
    windGain = ctx.createGain();
    windGain.gain.value = 0.020;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(master);
    wind.start();

    const swell = ctx.createOscillator();
    swell.frequency.value = 0.031;
    const swellGain = ctx.createGain();
    swellGain.gain.value = 0.012;
    swell.connect(swellGain);
    swellGain.connect(windGain.gain);
    swell.start();

    nextTime = ctx.currentTime + 0.4;
  }

  return {
    get available() {
      return typeof window !== "undefined" && !!(window.AudioContext || window.webkitAudioContext);
    },
    get playing() {
      return running && !muted;
    },
    async enable() {
      if (!this.available) return false;
      if (!ctx) build();
      if (ctx.state === "suspended") await ctx.resume();
      muted = false;
      if (!running) {
        running = true;
        timer = setInterval(pump, 120);
      }
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(0.5, ctx.currentTime, 1.4);
      return true;
    },
    disable() {
      if (!ctx) return;
      muted = true;
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(0.0, ctx.currentTime, 0.5);
    },
    toggle() {
      if (this.playing) {
        this.disable();
        return false;
      }
      this.enable();
      return true;
    },
    setElevation(v) {
      if (!ctx || !droneFilter) return;
      const t = Math.max(0, Math.min(1, v));
      droneFilter.frequency.setTargetAtTime(240 + t * 620, ctx.currentTime, 1.2);
      if (windFilter) {
        windFilter.frequency.setTargetAtTime(420 + t * 520, ctx.currentTime, 1.5);
      }
    },
  };
}