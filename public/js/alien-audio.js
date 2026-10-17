// Alien soundscape synthesised with the Web Audio API (no audio files):
// a low UFO hum that pans with the saucer, occasional theremin-like "voices",
// and short chirps when the bots act. Browsers only allow sound after a click,
// so start() must be called from a user gesture.

let ac = null, master = null, hum = null, humPan = null, humGain = null, voiceTimer = 0;
let musicBus = null, musicTimer = 0, delay = null, noiseBuf = null;

function env(gain, t0, attack, hold, release, peak) {
  gain.gain.cancelScheduledValues(t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  gain.gain.setValueAtTime(peak, t0 + attack + hold);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
}

// A gliding sine with fast vibrato: the classic "alien talking" sound.
function voice(path, { dur = 0.6, vib = 9, depth = 25, peak = 0.12, pan = 0 } = {}) {
  if (!ac) return;
  const t0 = ac.currentTime + 0.02;
  const osc = ac.createOscillator();
  osc.type = 'sine';
  const lfo = ac.createOscillator();
  const lfoGain = ac.createGain();
  lfo.frequency.value = vib;
  lfoGain.gain.value = depth;
  lfo.connect(lfoGain).connect(osc.frequency);
  osc.frequency.setValueAtTime(path[0], t0);
  path.slice(1).forEach((f, i) => osc.frequency.exponentialRampToValueAtTime(f, t0 + (dur * (i + 1)) / (path.length - 1)));
  const g = ac.createGain();
  const p = ac.createStereoPanner();
  p.pan.value = pan;
  osc.connect(g).connect(p).connect(master);
  env(g, t0, 0.04, dur * 0.6, dur * 0.4, peak);
  osc.start(t0); lfo.start(t0);
  osc.stop(t0 + dur + 0.1); lfo.stop(t0 + dur + 0.1);
}

function scheduleVoices() {
  clearTimeout(voiceTimer);
  voiceTimer = setTimeout(() => {
    const base = 500 + Math.random() * 500;
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      setTimeout(() => voice([base * (0.8 + Math.random() * 0.6), base * (1.2 + Math.random()), base * (0.7 + Math.random() * 0.5)],
        { dur: 0.35 + Math.random() * 0.5, vib: 6 + Math.random() * 8, depth: 20 + Math.random() * 40, peak: 0.07, pan: Math.random() * 1.6 - 0.8 }), i * 280);
    }
    scheduleVoices();
  }, 5000 + Math.random() * 7000);
}

// ---------- background music: an original spacey synthwave loop ----------
// 96 BPM, Am - F - C - G, with pad, pulsing bass, arpeggio through a delay, and light drums.
const BPM = 96;
const STEP = 60 / BPM / 4; // 16th note
const CHORDS = [
  [57, 60, 64], // Am
  [53, 57, 60], // F
  [48, 52, 55], // C
  [55, 59, 62], // G
];
const ARP = [0, 1, 2, 1, 2, 0, 1, 2];
const midi = (n) => 440 * 2 ** ((n - 69) / 12);
let step = 0, nextTime = 0;

function tone(type, freq, t, dur, peak, { cutoff = 4000, dest = musicBus, detune = 0 } = {}) {
  const o = ac.createOscillator();
  o.type = type; o.frequency.value = freq; o.detune.value = detune;
  const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
  const g = ac.createGain();
  o.connect(f).connect(g).connect(dest);
  env(g, t, Math.min(0.02, dur / 4), dur * 0.5, dur * 0.5, peak);
  o.start(t); o.stop(t + dur + 0.05);
}

function noise(t, dur, peak, type, freq) {
  const src = ac.createBufferSource(); src.buffer = noiseBuf;
  const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq;
  const g = ac.createGain();
  src.connect(f).connect(g).connect(musicBus);
  env(g, t, 0.002, 0.005, dur, peak);
  src.start(t); src.stop(t + dur + 0.05);
}

function kick(t) {
  const o = ac.createOscillator(); const g = ac.createGain();
  o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
  o.connect(g).connect(musicBus);
  env(g, t, 0.003, 0.02, 0.25, 0.5);
  o.start(t); o.stop(t + 0.35);
}

function scheduleStep(i, t) {
  const bar = Math.floor(i / 16) % CHORDS.length;
  const s = i % 16;
  const chord = CHORDS[bar];
  if (s === 0) {
    // pad: three detuned saws per note, long and soft
    for (const n of chord) for (const d of [-8, 0, 7]) tone('sawtooth', midi(n), t, STEP * 16, 0.018, { cutoff: 1400, detune: d });
  }
  if (s % 2 === 0) tone('square', midi(chord[0] - 24), t, STEP * 1.6, 0.05, { cutoff: 520 }); // bass
  tone('triangle', midi(chord[ARP[s % ARP.length]] + 12 + (s >= 8 ? 12 : 0)), t, STEP * 0.9, 0.035, { cutoff: 3200, dest: delay }); // arp
  if (s % 4 === 0) kick(t);
  if (s === 4 || s === 12) noise(t, 0.16, 0.12, 'bandpass', 1800); // snare
  if (s % 2 === 1) noise(t, 0.04, 0.04, 'highpass', 7000); // hat
}

function startMusic() {
  if (musicTimer) return;
  if (!noiseBuf) {
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  musicBus.gain.setTargetAtTime(0.55, ac.currentTime, 1.5);
  nextTime = ac.currentTime + 0.1;
  // look-ahead scheduler: queue notes ~150 ms ahead so timing stays tight
  musicTimer = setInterval(() => {
    while (nextTime < ac.currentTime + 0.15) {
      scheduleStep(step++, nextTime);
      nextTime += STEP;
    }
  }, 25);
}

function stopMusic() {
  clearInterval(musicTimer);
  musicTimer = 0;
  if (musicBus) musicBus.gain.setTargetAtTime(0.0001, ac.currentTime, 0.2);
}

export const alienAudio = {
  get on() { return !!ac && ac.state === 'running'; },

  async start() {
    if (!ac) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      ac = new Ctx();
      master = ac.createGain();
      master.gain.value = 0.5;
      master.connect(ac.destination);
      // UFO hum: two detuned saws through a low-pass with a slow wobble
      humGain = ac.createGain();
      humGain.gain.value = 0.0001;
      humPan = ac.createStereoPanner();
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 260; lp.Q.value = 6;
      const wob = ac.createOscillator(); const wobGain = ac.createGain();
      wob.frequency.value = 0.35; wobGain.gain.value = 90;
      wob.connect(wobGain).connect(lp.frequency);
      hum = [72, 108.6].map((f) => { const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(lp); o.start(); return o; });
      lp.connect(humGain).connect(humPan).connect(master);
      wob.start();
      // music bus with a feedback delay for the arpeggio
      musicBus = ac.createGain();
      musicBus.gain.value = 0.0001;
      musicBus.connect(master);
      delay = ac.createGain();
      const dl = ac.createDelay(1); dl.delayTime.value = STEP * 3;
      const fb = ac.createGain(); fb.gain.value = 0.38;
      delay.connect(musicBus);
      delay.connect(dl).connect(fb).connect(dl);
      dl.connect(musicBus);
    }
    await ac.resume();
    humGain.gain.setTargetAtTime(0.05, ac.currentTime, 0.8);
    voice([420, 1300, 760], { dur: 0.7, peak: 0.1 });
    scheduleVoices();
    if (this.musicOn) startMusic();
    return true;
  },

  musicOn: true,

  setMusic(on) {
    this.musicOn = on;
    if (!this.on) return;
    if (on) startMusic(); else stopMusic();
  },

  async stop() {
    clearTimeout(voiceTimer);
    stopMusic();
    if (!ac) return;
    humGain.gain.setTargetAtTime(0.0001, ac.currentTime, 0.15);
    setTimeout(() => ac.suspend(), 400);
  },

  // x: saucer position 0..1 across the screen; beam: 0..1 tractor beam strength
  ufo(x, beam = 0) {
    if (!this.on) return;
    humPan.pan.setTargetAtTime(Math.max(-1, Math.min(1, x * 2 - 1)), ac.currentTime, 0.1);
    humGain.gain.setTargetAtTime(0.05 + beam * 0.05, ac.currentTime, 0.2);
    hum[1].frequency.setTargetAtTime(108.6 + beam * 40, ac.currentTime, 0.3);
  },

  // short cues for bot activity
  cue(kind) {
    if (!this.on) return;
    if (kind === 'tp') voice([600, 900, 1500], { dur: 0.45, vib: 12, depth: 15, peak: 0.1 });
    else if (kind === 'sl') voice([700, 420, 220], { dur: 0.55, vib: 5, depth: 30, peak: 0.1 });
    else voice([880, 1100], { dur: 0.18, vib: 20, depth: 10, peak: 0.06 });
  },
};
