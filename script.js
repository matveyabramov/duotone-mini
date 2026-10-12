'use strict';

// UI state and musical parameter ranges. Frequency and time controls use log scales.
const parameters = {
  cutoff: { label: 'Cutoff', min: 80, max: 16000, value: 2400, log: true },
  resonance: { label: 'Resonance', min: 0, max: 1, value: .32 },
  reverb: { label: 'Reverb', min: 0, max: 1, value: .28 },
  delay: { label: 'Delay', min: 0, max: 1, value: .18 },
  attack: { label: 'Attack', min: .002, max: 2, value: .012, log: true },
  decay: { label: 'Decay', min: .02, max: 3, value: .48, log: true },
  sustain: { label: 'Sustain', min: 0, max: 1, value: .76 },
  release: { label: 'Release', min: .03, max: 6, value: 1.2, log: true }
};
const levels = { synth: 10 ** (-3 / 20), drums: 10 ** (-6 / 20), fx: .24, master: 10 ** (-1 / 20) };
// Fixed routing: full stereo voice mixes are panned after their effect returns.
const voiceRouting = { synthPan: -.25, drumPan: .25, drumCutoff: 18000,
  drumQ: .5, drumRoom: .18, drumDampening: 6000, drumReturn: .04 };
// StereoPanner adds correlated centre content toward the chosen side. This trim
// preserves the total L/R power of a dual-mono dry source at the fixed positions.
function panTrim(pan) { return 1 / Math.sqrt(1 + Math.sin(Math.abs(pan) * Math.PI / 2)); }
// Local TR-909 recordings from the teacher's tutorial_4. Each mapping plays at
// its recorded pitch; the notes remain pad metadata, independent of synth octave.
const drumSampleBaseUrl = 'assets/audio/';
const drumSamples = [
  { name: 'Kick', note: 'C1', label: 'C1', file: 'BT7A0D0.WAV' },
  { name: 'Snare', note: 'D1', label: 'D1', file: 'ST0T3S7.WAV' },
  { name: 'Clap', note: 'D#1', label: 'D♯1', file: 'HANDCLP1.WAV' },
  { name: 'Closed HH', note: 'F#1', label: 'F♯1', file: 'HHCD6.WAV' },
  { name: 'Open HH', note: 'A#1', label: 'A♯1', file: 'HHOD6.WAV' },
  { name: 'Low tom', note: 'F1', label: 'F1', file: 'LT3D7.WAV' },
  { name: 'Perc', note: 'G1', label: 'G1', file: 'RIM127.WAV' },
  { name: 'Texture', note: 'C2', label: 'C2', file: 'CSHD6.WAV' }
];
const drumVoices = [];
const padStates = drumSamples.map(() => ({ pressed: new Set(), request: 0, flashing: false, timer: null }));
let drumGeneration = 0;
let oledTimer = null;
let bpm = 120;
let sequence = null;
let transportState = 'stopped';
let transportGeneration = 0;
let observedTransport = null;
let lastScheduledAudioTime = 0;
const performanceFade = .3;
const effectFlush = .35;
let cleanupUntil = 0;
let cleanupTimer = null;
const keyboardCodes = ['KeyZ','KeyS','KeyX','KeyD','KeyC','KeyV','KeyG','KeyB','KeyH','KeyN','KeyJ','KeyM','KeyQ','Digit2','KeyW','Digit3','KeyE','KeyR','Digit5','KeyT','Digit6','KeyY','Digit7','KeyU','KeyI'];
const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const sources = new Map();
const soundingNotes = new Set();
const latchedNotes = new Set();
let octave = 0;
let hold = false;
let lastParameter = 'CUTOFF 2.40k';
let lastNote = 'READY';
let audio = null;
let audioStarting = null;
let noteGeneration = 0;

const readout = document.getElementById('readout');
const piano = document.getElementById('piano');
const holdButton = document.getElementById('hold');
function noteName(midi) { return noteNames[midi % 12] + (Math.floor(midi / 12) - 1); }
function display() {
  clearTimeout(oledTimer);
  document.getElementById('oled-voice').textContent = 'VOICE A · POLY SYNTH';
  document.getElementById('oled-title').textContent = importedMidi?.filename ?? 'Glass Horizon';
  readout.textContent = `${lastParameter} · ${lastNote}`;
}
function drumFeedback(index, status) {
  clearTimeout(oledTimer);
  document.getElementById('oled-voice').textContent = 'VOICE B · SAMPLER';
  document.getElementById('oled-title').textContent = drumSamples[index].name.toUpperCase();
  readout.textContent = `${drumSamples[index].label} · ${status}`;
  oledTimer = setTimeout(display, 1400);
}
function normalize(parameter) {
  return parameter.log ? Math.log(parameter.value / parameter.min) / Math.log(parameter.max / parameter.min) : (parameter.value - parameter.min) / (parameter.max - parameter.min);
}
function parameterValue(parameter, position) {
  return parameter.log ? parameter.min * (parameter.max / parameter.min) ** position : parameter.min + (parameter.max - parameter.min) * position;
}
function formatParameter(id) {
  const value = parameters[id].value;
  if (id === 'cutoff') return value >= 1000 ? `${(value / 1000).toFixed(2)}k` : `${Math.round(value)}Hz`;
  if (['attack', 'decay', 'release'].includes(id)) return value < 1 ? `${Math.round(value * 1000)}ms` : `${value.toFixed(2)}s`;
  return `${Math.round(value * 100)}%`;
}
function formatLevel(id) {
  return id === 'fx' ? `${Math.round(levels[id] * 100)}%` : levels[id] === 0 ? '−∞ dB' : `${(20 * Math.log10(levels[id])).toFixed(0).replace('-', '−')} dB`;
}

// Each voice sums its own dry/wet paths, then pans the complete stereo bus.
// Synth controls its dry sound and FX inputs; Drums controls its whole dry/wet mix.
async function ensureAudio() {
  if (!window.Tone) throw new Error('Tone.js did not load');
  if (audioStarting) return audioStarting;
  audioStarting = (async () => {
    await Tone.start();
    observeTransport(Tone.getTransport());
    if (!audio) {
      const performance = new Tone.Gain(1).toDestination();
      // Fixed output protection: normal mixes retain their level; dense chords
      // at maximum faders are limited before the common performance fade.
      const outputGuard = new Tone.WaveShaper(value => {
        const magnitude = Math.abs(value);
        return magnitude <= .8 ? value : Math.sign(value) * (.8 + .15 * Math.tanh((magnitude - .8) / .15));
      }, 4097).connect(performance);
      const master = new Tone.Gain(levels.master).connect(outputGuard);
      const synthPanner = new Tone.Panner({ pan: voiceRouting.synthPan, channelCount: 2 }).connect(master);
      const drumPanner = new Tone.Panner({ pan: voiceRouting.drumPan, channelCount: 2 }).connect(master);
      const synthBus = new Tone.Gain(panTrim(voiceRouting.synthPan)).connect(synthPanner);
      const drumBus = new Tone.Gain(panTrim(voiceRouting.drumPan)).connect(drumPanner);
      // Keep stereo effect returns intact and dry sources consistently dual-mono,
      // even when an effect return is muted. No channel splitter or phase inversion.
      for (const bus of [synthBus, drumBus]) {
        bus.channelCount = 2;
        bus.channelCountMode = 'explicit';
      }
      const synthLevel = new Tone.Gain(levels.synth);
      const drumLevel = new Tone.Gain(levels.drums).connect(drumBus);
      const drumReverbReturn = new Tone.Gain(voiceRouting.drumReturn).connect(drumLevel);
      const drumReverb = new Tone.Freeverb({ roomSize: voiceRouting.drumRoom,
        dampening: voiceRouting.drumDampening, wet: 1 }).connect(drumReverbReturn);
      const drumFilter = new Tone.Filter({ frequency: voiceRouting.drumCutoff,
        type: 'lowpass', rolloff: -12, Q: voiceRouting.drumQ }).connect(drumLevel);
      drumFilter.connect(drumReverb);
      const fxLevel = new Tone.Gain(levels.fx).connect(synthBus);
      const reverbSend = new Tone.Gain(parameters.reverb.value).connect(fxLevel);
      const delaySend = new Tone.Gain(parameters.delay.value).connect(fxLevel);
      const reverb = new Tone.Freeverb({ roomSize: .72, dampening: 4500, wet: 1 }).connect(reverbSend);
      const delay = new Tone.FeedbackDelay({ delayTime: .25, feedback: .28, wet: 1 }).connect(delaySend);
      const filter = new Tone.Filter({ frequency: parameters.cutoff.value, type: 'lowpass', rolloff: -24, Q: .5 + parameters.resonance.value * 7.5 }).connect(synthLevel);
      const synth = new Tone.PolySynth(Tone.Synth, {
        volume: -18,
        oscillator: { type: 'sawtooth' },
        envelope: { attack: parameters.attack.value, decay: parameters.decay.value, sustain: parameters.sustain.value, release: parameters.release.value }
      }).connect(filter);
      synth.maxPolyphony = 32;
      synthLevel.connect(synthBus);
      synthLevel.connect(reverb);
      synthLevel.connect(delay);
      audio = { synth, filter, synthLevel, synthBus, synthPanner, drumFilter, drumReverb,
        drumReverbReturn, drumLevel, drumBus, drumPanner, fxLevel, reverbSend,
        delaySend, reverb, delay, master, outputGuard, performance };
      cleanupUntil = 0;
      lastScheduledAudioTime = 0;
    }
  })();
  try { await audioStarting; } finally { audioStarting = null; }
}
function audioError(error) {
  console.error('DUOTONE MINI: audio could not start.', error);
  releaseAll();
  lastNote = 'AUDIO UNAVAILABLE';
  display();
}
function applyParameter(id) {
  if (!audio) return;
  const value = parameters[id].value;
  if (id === 'cutoff') audio.filter.frequency.rampTo(value, .025);
  else if (id === 'resonance') audio.filter.Q.rampTo(.5 + value * 7.5, .025);
  else if (id === 'reverb') audio.reverbSend.gain.rampTo(value, .025);
  else if (id === 'delay') audio.delaySend.gain.rampTo(value, .025);
  else audio.synth.set({ envelope: { [id]: value } });
}
function applyLevel(id) {
  if (!audio) return;
  const node = { synth: audio.synthLevel, drums: audio.drumLevel, fx: audio.fxLevel, master: audio.master }[id];
  node?.gain.rampTo(levels[id], .025);
}

// One single-sample Sampler per pad keeps a missing file isolated from the other
// drums. All eight enter Voice B's own filter; no connection to Voice A's effects.
function loadDrum(index) {
  if (drumVoices[index] && drumVoices[index].state !== 'failed') return drumVoices[index];
  drumVoices[index]?.sampler?.dispose();
  const sample = drumSamples[index];
  const voice = { sampler: null, state: 'loading', ready: null };
  drumVoices[index] = voice;
  voice.ready = new Promise(resolve => {
    const finish = success => {
      if (voice.state !== 'loading') return;
      clearTimeout(timeout);
      voice.state = success ? 'ready' : 'failed';
      const pad = document.getElementById('pads').children[index];
      pad.dataset.sampleState = voice.state;
      pad.title = success ? sample.name : `${sample.name}: sample unavailable. Press to retry.`;
      resolve(success);
    };
    const timeout = setTimeout(() => finish(false), 15000);
    try {
      voice.sampler = new Tone.Sampler({
        urls: { [sample.note]: sample.file },
        baseUrl: drumSampleBaseUrl,
        attack: .001,
        release: .05,
        volume: -6,
        onload: () => finish(true),
        onerror: () => finish(false)
      }).connect(audio.drumFilter);
    } catch { finish(false); }
  });
  return voice;
}
function refreshPad(index) {
  const state = padStates[index];
  const pad = document.getElementById('pads').children[index];
  const active = state.flashing;
  pad.classList.toggle('is-active', active);
  pad.setAttribute('aria-pressed', String(active));
}
function flashPad(index) {
  const state = padStates[index];
  clearTimeout(state.timer);
  state.flashing = true;
  refreshPad(index);
  state.timer = setTimeout(() => { state.flashing = false; refreshPad(index); }, 120);
}
async function triggerDrum(index) {
  const request = ++padStates[index].request;
  const generation = drumGeneration;
  try {
    await ensureAudio();
    if (generation !== drumGeneration) return;
    await waitForAudioCleanup();
    if (generation !== drumGeneration) return;
    const voice = loadDrum(index);
    if (voice.state === 'loading') drumFeedback(index, 'LOADING SAMPLE');
    const loaded = await voice.ready;
    // Keep only the latest hit per pad while loading; never replay a backlog or
    // resurrect pending hits after Stop / focus loss / a cancelled touch.
    if (generation !== drumGeneration || request !== padStates[index].request) return;
    if (!loaded) { drumFeedback(index, 'SAMPLE UNAVAILABLE'); return; }
    // Sampler buffers are finite one-shots: lifting a pad does not cut off a tail.
    playDrum(index);
  } catch {
    if (generation === drumGeneration) drumFeedback(index, 'AUDIO UNAVAILABLE');
  }
}
function pressPad(index, token) {
  if (padStates[index].pressed.has(token)) return;
  padStates[index].pressed.add(token);
  flashPad(index);
  triggerDrum(index);
}
function releasePad(index, token, cancelled = false) {
  if (!padStates[index].pressed.delete(token)) return;
  if (cancelled) {
    padStates[index].request++;
    clearTimeout(padStates[index].timer);
    padStates[index].flashing = false;
  }
  refreshPad(index);
}
function stopDrums(time = audio?.synth.context.immediate() ?? 0) {
  drumGeneration++;
  for (let index = 0; index < padStates.length; index++) {
    clearTimeout(padStates[index].timer);
    padStates[index].pressed.clear();
    padStates[index].flashing = false;
    drumVoices[index]?.sampler?.releaseAll(time);
    refreshPad(index);
  }
  display();
}

// Manual and scheduled hits share audio and feedback; Draw aligns visuals with
// the audible hit rather than Transport's audio scheduling lookahead.
function playDrum(index, time, velocity = .9, playbackGeneration = null) {
  const voice = drumVoices[index];
  if (voice?.state !== 'ready') return;
  lastScheduledAudioTime = Math.max(lastScheduledAudioTime, time ?? Tone.now());
  voice.sampler.triggerAttack(drumSamples[index].note, time, velocity);
  const generation = drumGeneration;
  const feedback = () => {
    if (generation !== drumGeneration) return;
    if (playbackGeneration !== null && (playbackGeneration !== transportGeneration || !['playing', 'finishing'].includes(transportState))) return;
    flashPad(index);
    if (playbackGeneration === null || !importedMidi) drumFeedback(index, 'ONE SHOT');
  };
  if (time === undefined) feedback();
  else Tone.getDraw().schedule(feedback, time);
}
// A unity safety gain fades the entire dry/wet/drum mix without changing faders.
// Flush the existing effect buffers with feedback disabled while the mix is muted.
// All automation belongs to the graph's context (also valid during Tone.Offline).
function silencePerformance(time) {
  if (!audio) return;
  const graph = audio, context = graph.synth.context;
  const fadeEnd = time + performanceFade;
  const ready = Math.max(fadeEnd, lastScheduledAudioTime + .02) + effectFlush;
  if (cleanupTimer !== null) cleanupTimer.context.clearTimeout(cleanupTimer.id);
  cleanupTimer = null;
  cleanupUntil = ready;
  const gain = graph.performance.gain;
  gain.cancelAndHoldAtTime(time);
  gain.linearRampToValueAtTime(0, fadeEnd);
  gain.setValueAtTime(0, ready);
  gain.linearRampToValueAtTime(1, ready + .01);
  for (const [signal, normal] of [[graph.reverb.roomSize, .72], [graph.delay.feedback, .28],
      [graph.drumReverb.roomSize, voiceRouting.drumRoom]]) {
    signal.cancelScheduledValues(time);
    signal.setValueAtTime(normal, time);
    signal.setValueAtTime(0, fadeEnd);
    signal.setValueAtTime(normal, ready);
  }
  // Lookahead may already have queued attacks after a manual Stop. Release again
  // after every queued attack, shortening even voices already in their Release.
  const releaseTime = Math.max(fadeEnd, lastScheduledAudioTime + .001);
  const id = context.setTimeout(() => {
    cleanupTimer = null;
    if (audio !== graph) return;
    graph.synth.set({ envelope: { release: .015 } });
    graph.synth.releaseAll(releaseTime);
    graph.synth.set({ envelope: { release: parameters.release.value } });
    for (const voice of drumVoices) voice?.sampler?.releaseAll(releaseTime);
  }, Math.max(0, releaseTime - context.now()));
  cleanupTimer = { context, id };
}
async function waitForAudioCleanup() {
  const graph = audio;
  // Offline rendering advances audio time after the setup function has returned.
  if (!graph || graph.synth.context.isOffline) return;
  while (audio === graph && graph.synth.context.immediate() < cleanupUntil + .01) {
    await new Promise(resolve => setTimeout(resolve,
      Math.min(50, Math.max(1, (cleanupUntil + .01 - graph.synth.context.immediate()) * 1000))));
  }
}
function finishComposition(time, generation, transport) {
  // This runs in scheduler lookahead: silence is scheduled at time, never now.
  transportState = 'finishing';
  sequence?.stop(`${midiEndTick}i`);
  transport.stop(time);
  silencePerformance(time);
  audio.synth.releaseAll(time);
  for (const voice of drumVoices) voice?.sampler?.releaseAll(time);
  Tone.getDraw().schedule(() => {
    if (generation !== transportGeneration || transportState !== 'finishing') return;
    transportGeneration++;
    transportState = 'stopped';
    transport.position = 0;
    sequence?.dispose();
    sequence = null;
    clearMidiPlayback(time);
    releaseAll(time);
    stopDrums(time);
    refreshTransport();
    lastNote = 'FINISHED';
    display();
    oledTimer = setTimeout(() => {
      if (generation + 1 !== transportGeneration || transportState !== 'stopped') return;
      lastNote = 'READY';
      display();
    }, 1800);
  }, time);
}
function setBpm(value) {
  const parsed = Number(value);
  const min = Math.min(50, importedMidi?.tempo ?? bpm);
  const max = Math.max(200, importedMidi?.tempo ?? bpm);
  if (value !== '' && Number.isFinite(parsed)) bpm = Math.min(max, Math.max(min, parsed));
  document.getElementById('bpm').min = min;
  document.getElementById('bpm').max = max;
  document.getElementById('bpm').value = bpm.toFixed(1);
  document.getElementById('bpm').title = `Edit tempo or use arrow keys (${min}–${max} BPM)`;
  if (window.Tone) Tone.getTransport().bpm.value = bpm;
}
function refreshTransport() {
  const button = document.getElementById('play');
  button.setAttribute('aria-pressed', String(transportState === 'playing' && observedTransport?.state === 'started'));
  button.setAttribute('aria-busy', String(transportState === 'loading'));
  button.title = transportState === 'loading' ? 'Loading groove samples…' : importedMidi ? 'Play imported melody with drums' : 'Start the four-beat drum groove';
}
function transportStarted() { refreshTransport(); }
function transportStopped() {
  if (transportState === 'finishing') return;
  if (transportState !== 'stopped') stopTransport(false);
  else refreshTransport();
}
function observeTransport(transport) {
  if (observedTransport === transport) return;
  observedTransport?.off('start', transportStarted);
  observedTransport?.off('stop', transportStopped);
  observedTransport?.off('pause', transportStopped);
  observedTransport = transport;
  transport.on('start', transportStarted);
  transport.on('stop', transportStopped);
  transport.on('pause', transportStopped);
  refreshTransport();
}
async function startTransport() {
  if (transportState === 'finishing') stopTransport();
  if (transportState !== 'stopped') return;
  const generation = ++transportGeneration;
  transportState = 'loading';
  refreshTransport();
  try {
    await ensureAudio();
    if (generation !== transportGeneration) return;
    await waitForAudioCleanup();
    if (generation !== transportGeneration) return;
    lastScheduledAudioTime = Tone.immediate();
    const required = [0, 1, 3];
    const loaded = await Promise.all(required.map(index => loadDrum(index).ready));
    if (generation !== transportGeneration) return;
    const failed = loaded.indexOf(false);
    if (failed !== -1) {
      transportState = 'stopped';
      refreshTransport();
      drumFeedback(required[failed], 'SAMPLE UNAVAILABLE');
      return;
    }
    const transport = Tone.getTransport();
    transport.bpm.value = bpm;
    sequence = new Tone.Sequence((time, step) => {
      if (generation !== transportGeneration || transportState !== 'playing') return;
      if (midiEndTick !== null && transport.getTicksAtTime(time) >= midiEndTick) return;
      playDrum(3, time, step % 2 === 0 ? .55 : .4, generation);
      if (step === 0 || step === 4) playDrum(0, time, .9, generation);
      if (step === 2 || step === 6) playDrum(1, time, .85, generation);
    }, [0, 1, 2, 3, 4, 5, 6, 7], '8n').start(0);
    scheduleMidi(generation, transport);
    transportState = 'playing';
    transport.start(undefined, 0);
    refreshTransport();
  } catch {
    if (generation !== transportGeneration) return;
    stopTransport();
    lastNote = 'GROOVE UNAVAILABLE';
    display();
  }
}
function stopTransport(stopClock = true, time = audio?.synth.context.immediate() ?? 0) {
  transportGeneration++;
  transportState = 'stopped';
  if (observedTransport) {
    if (stopClock) observedTransport.stop(time);
    observedTransport.position = 0;
  }
  sequence?.dispose();
  sequence = null;
  silencePerformance(time);
  clearMidiPlayback(time);
  releaseAll(time);
  refreshTransport();
  // Cancel pending manual hits and scheduled drum tails, including lookahead hits.
  stopDrums(time);
}

// Track each physical source separately so simultaneous mouse/keyboard notes release safely.
function refreshKeys() {
  refreshMidiRange();
  for (const key of piano.children) {
    const midi = 48 + Number(key.dataset.index) + octave * 12;
    const active = [...sources.values()].some(source => source.active && source.midi === midi) ||
      latchedNotes.has(midi) || [...midiVisualNotes.values()].includes(midi);
    key.classList.toggle('is-active', active);
    key.setAttribute('aria-pressed', String(active));
  }
}
function releaseManualPitch(midi) {
  if (!soundingNotes.delete(midi)) return;
  if (!midiPitchCounts.has(midi)) audio?.synth.triggerRelease(noteName(midi));
}
function unlatchNote(midi) {
  latchedNotes.delete(midi);
  // A toggled-off note must not reappear when an older physical key is released.
  for (const source of sources.values()) {
    if (source.midi === midi) source.active = false;
  }
  releaseManualPitch(midi);
}
async function noteOn(token, index) {
  if (sources.has(token)) return;
  const source = { midi: 48 + index + octave * 12, active: true, latch: hold,
    started: false, released: false, generation: noteGeneration };
  sources.set(token, source);
  // Toggle on the press, before awaiting browser audio, so rapid startup taps
  // resolve to the final latch state rather than replaying stale note requests.
  if (source.latch) {
    if (latchedNotes.has(source.midi)) unlatchNote(source.midi);
    else latchedNotes.add(source.midi);
  }
  refreshKeys();
  try {
    await ensureAudio();
    await waitForAudioCleanup();
    if (source.generation !== noteGeneration || !source.active) return;
    if (source.latch) {
      if (!latchedNotes.has(source.midi)) return;
    } else if (sources.get(token) !== source) {
      // Preserve a quick first tap, but never cut a newer held note of this pitch.
      if (!source.released || soundingNotes.has(source.midi) ||
        [...sources.values()].some(other => other.active && other.midi === source.midi)) return;
      if (!midiPitchCounts.has(source.midi)) {
        lastScheduledAudioTime = Math.max(lastScheduledAudioTime, Tone.now() + .06);
        audio.synth.triggerAttackRelease(noteName(source.midi), .06, undefined, .8);
      }
      lastNote = `${noteName(source.midi)} / ${keyboardCodes[index].replace('Key', '').replace('Digit', '')}`;
      display();
      refreshKeys();
      return;
    }
    if (!soundingNotes.has(source.midi)) {
      if (!midiPitchCounts.has(source.midi)) {
        lastScheduledAudioTime = Math.max(lastScheduledAudioTime, Tone.now());
        audio.synth.triggerAttack(noteName(source.midi), undefined, .8);
      }
      soundingNotes.add(source.midi);
    }
    source.started = true;
    lastNote = `${noteName(source.midi)} / ${keyboardCodes[index].replace('Key', '').replace('Digit', '')}`;
    display();
    refreshKeys();
  } catch (error) { audioError(error); }
}
function noteOff(token, cancelled = false) {
  const source = sources.get(token);
  if (!source) return;
  sources.delete(token);
  source.released = !cancelled;
  if (source.latch) {
    if (cancelled && source.active) unlatchNote(source.midi);
  } else if (source.active && source.started && !latchedNotes.has(source.midi) &&
    ![...sources.values()].some(other => other.active && other.midi === source.midi)) {
    releaseManualPitch(source.midi);
  }
  refreshKeys();
}
function releaseAll(time = audio?.synth.context.immediate() ?? 0) {
  noteGeneration++;
  sources.clear();
  latchedNotes.clear();
  for (const midi of soundingNotes) {
    if (!midiPitchCounts.has(midi)) audio?.synth.triggerRelease(noteName(midi), time);
  }
  soundingNotes.clear();
  if (!midiPitchCounts.size) audio?.synth.releaseAll(time);
  refreshKeys();
}
function setHold(value) {
  hold = value;
  holdButton.setAttribute('aria-pressed', String(hold));
  if (hold) {
    for (const source of sources.values()) {
      if (!source.active) continue;
      source.latch = true;
      latchedNotes.add(source.midi);
    }
  } else {
    for (const midi of [...latchedNotes]) unlatchNote(midi);
  }
  lastNote = hold ? 'HOLD ON' : 'HOLD OFF';
  display();
  refreshKeys();
}
function changeOctave(delta) {
  const next = Math.max(-2, Math.min(2, octave + delta));
  if (next === octave) return;
  // Existing manual sources and latches keep their original pitch until released.
  octave = next;
  document.getElementById('octave').textContent = octave === 0 ? '±0' : `${octave > 0 ? '+' : '−'}${Math.abs(octave)}`;
  document.getElementById('oct-down').disabled = octave === -2;
  document.getElementById('oct-up').disabled = octave === 2;
  document.getElementById('keyboard-range').textContent = `25 KEYS · C${3 + octave}–C${5 + octave}`;
  for (const key of piano.children) {
    const name = noteName(48 + Number(key.dataset.index) + octave * 12);
    key.querySelector('span').textContent = name;
    key.setAttribute('aria-label', `${name}, ${keyboardCodes[key.dataset.index].replace('Key', '').replace('Digit', '')}`);
  }
  lastNote = `OCT ${octave > 0 ? '+' : ''}${octave}`;
  display();
  refreshKeys();
}

// Build the repeated controls from the approved design, using native accessible ranges.
for (const [id, parameter] of Object.entries(parameters)) {
  const initial = normalize(parameter);
  const knob = document.createElement('div');
  knob.className = 'knob';
  knob.innerHTML = `<div class="dial"><img src="assets/ui/${id}.svg" alt="" width="62" height="63"><input id="${id}" type="range" min="0" max="1000" step="1" value="${Math.round(initial * 1000)}" aria-label="${parameter.label}"></div><label for="${id}">${parameter.label}</label><output for="${id}">${formatParameter(id)}</output>`;
  document.getElementById('knobs').append(knob);
  const input = knob.querySelector('input');
  const update = () => {
    parameters[id].value = parameterValue(parameter, Number(input.value) / 1000);
    const formatted = formatParameter(id);
    knob.querySelector('output').textContent = formatted;
    input.setAttribute('aria-valuetext', formatted);
    knob.style.setProperty('--rotation', `${(Number(input.value) / 1000 - initial) * 270}deg`);
    lastParameter = `${parameter.label.toUpperCase()} ${formatted}`;
    display();
    applyParameter(id);
  };
  input.setAttribute('aria-valuetext', formatParameter(id));
  input.addEventListener('input', update);
  let drag = null;
  input.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    input.focus();
    input.setPointerCapture(event.pointerId);
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, value: Number(input.value) };
    ensureAudio().catch(audioError);
  });
  input.addEventListener('pointermove', event => {
    if (drag?.pointer !== event.pointerId) return;
    input.value = Math.max(0, Math.min(1000, drag.value + (drag.y - event.clientY + event.clientX - drag.x) * 5));
    update();
  });
  const endDrag = () => { drag = null; };
  input.addEventListener('pointerup', endDrag);
  input.addEventListener('pointercancel', endDrag);
  input.addEventListener('lostpointercapture', endDrag);
}
for (const [index, sample] of drumSamples.entries()) {
  const pad = document.createElement('button');
  pad.className = 'pad';
  pad.title = sample.name;
  pad.setAttribute('aria-label', sample.name);
  pad.setAttribute('aria-pressed', 'false');
  pad.dataset.sampleState = 'idle';
  pad.innerHTML = `<span class="pad-meta"><span>0${index + 1}</span><span>${sample.label}</span></span><span class="pad-sound">${sample.name}</span>`;
  document.getElementById('pads').append(pad);
  pad.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    pad.setPointerCapture(event.pointerId);
    pressPad(index, `pointer:${event.pointerId}`);
  });
  pad.addEventListener('pointerup', event => releasePad(index, `pointer:${event.pointerId}`));
  pad.addEventListener('pointercancel', event => releasePad(index, `pointer:${event.pointerId}`, true));
  pad.addEventListener('lostpointercapture', event => releasePad(index, `pointer:${event.pointerId}`, true));
  pad.addEventListener('keydown', event => {
    if (!['Space', 'Enter'].includes(event.code)) return;
    event.preventDefault();
    if (!event.repeat) pressPad(index, `key:${event.code}`);
  });
  pad.addEventListener('keyup', event => {
    if (!['Space', 'Enter'].includes(event.code)) return;
    event.preventDefault();
    releasePad(index, `key:${event.code}`);
  });
  pad.addEventListener('blur', () => {
    releasePad(index, 'key:Space', true);
    releasePad(index, 'key:Enter', true);
  });
  // Assistive clicks have no pointer event; native pointer clicks already fired above.
  pad.addEventListener('click', event => { if (event.detail === 0) triggerDrum(index); });
}
for (const id of ['synth','drums','fx','master']) {
  const label = { synth: 'Synth', drums: 'Drums', fx: 'FX', master: 'Master' }[id];
  const fader = document.createElement('div');
  fader.className = 'fader';
  fader.innerHTML = `<label for="level-${id}">${label}</label><div class="fader-travel"><div class="scale" aria-hidden="true">${'<i></i>'.repeat(7)}</div><div class="track"></div><div class="level-light"></div><div class="fader-cap"></div><input id="level-${id}" type="range" min="0" max="100" step="1" value="${Math.round(levels[id] * 100)}" aria-label="${label} level"></div><output for="level-${id}">${formatLevel(id)}</output>`;
  fader.style.setProperty('--level', levels[id]);
  document.getElementById('faders').append(fader);
  const input = fader.querySelector('input');
  input.title = { synth: 'Voice A level and input to its effects', drums: 'Voice B drums and reverb',
    fx: 'Voice A reverb and delay only', master: 'Overall instrument level' }[id];
  input.setAttribute('aria-valuetext', formatLevel(id));
  input.addEventListener('input', () => {
    levels[id] = Number(input.value) / 100;
    fader.style.setProperty('--level', levels[id]);
    fader.querySelector('output').textContent = formatLevel(id);
    input.setAttribute('aria-valuetext', formatLevel(id));
    lastParameter = `${label.toUpperCase()} ${formatLevel(id)}`;
    display();
    applyLevel(id);
  });
  input.addEventListener('pointerdown', () => ensureAudio().catch(audioError));
}
let whiteIndex = 0;
for (let index = 0; index < 25; index++) {
  const name = noteName(48 + index);
  const accidental = name.includes('#');
  const key = document.createElement('button');
  key.className = `piano-key ${accidental ? 'accidental' : 'natural'}`;
  key.dataset.index = index;
  key.setAttribute('aria-pressed', 'false');
  const letter = keyboardCodes[index].replace('Key', '').replace('Digit', '');
  key.setAttribute('aria-label', `${name}, ${letter}`);
  key.innerHTML = `<span>${name}</span><small>${letter}</small>`;
  if (accidental) key.style.setProperty('--white-index', whiteIndex);
  else whiteIndex++;
  piano.append(key);
  key.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    key.setPointerCapture(event.pointerId);
    noteOn(`pointer:${event.pointerId}`, index);
  });
  key.addEventListener('pointerup', event => noteOff(`pointer:${event.pointerId}`));
  key.addEventListener('pointercancel', event => noteOff(`pointer:${event.pointerId}`, true));
  key.addEventListener('lostpointercapture', event => noteOff(`pointer:${event.pointerId}`, true));
  key.addEventListener('keydown', event => {
    if (!['Space','Enter'].includes(event.code)) return;
    event.preventDefault();
    if (!event.repeat) noteOn(`accessible:${index}`, index);
  });
  key.addEventListener('keyup', event => {
    if (['Space','Enter'].includes(event.code)) { event.preventDefault(); noteOff(`accessible:${index}`); }
  });
  key.addEventListener('blur', () => noteOff(`accessible:${index}`, true));
}
window.addEventListener('keydown', event => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
  const index = keyboardCodes.indexOf(event.code);
  if (index === -1) return;
  event.preventDefault();
  noteOn(`keyboard:${event.code}`, index);
});
window.addEventListener('keyup', event => noteOff(`keyboard:${event.code}`));
window.addEventListener('pointerup', event => noteOff(`pointer:${event.pointerId}`));
window.addEventListener('pointercancel', event => noteOff(`pointer:${event.pointerId}`, true));
holdButton.addEventListener('click', () => { setHold(!hold); ensureAudio().catch(audioError); });
document.getElementById('oct-down').addEventListener('click', () => changeOctave(-1));
document.getElementById('oct-up').addEventListener('click', () => changeOctave(1));
document.getElementById('bpm').addEventListener('change', event => setBpm(event.target.value));
document.getElementById('bpm').addEventListener('keydown', event => {
  if (event.code === 'Enter') { event.preventDefault(); setBpm(event.target.value); }
  if (['ArrowUp', 'ArrowDown'].includes(event.code)) {
    event.preventDefault();
    setBpm(Number(event.target.value || bpm) + (event.code === 'ArrowUp' ? 1 : -1));
  }
});
document.getElementById('play').addEventListener('click', startTransport);
document.getElementById('stop').addEventListener('click', () => { stopTransport(); lastNote = 'STOP'; display(); });
const midiFileInput = document.getElementById('midi-file');
document.getElementById('import').addEventListener('click', () => {
  midiFileInput.value = '';
  midiFileInput.click();
});
midiFileInput.addEventListener('change', () => importMidiFile(midiFileInput.files[0]));

// Drum lifecycle is separate: octave and Hold continue to affect only Voice A.
window.addEventListener('blur', () => stopTransport());
document.addEventListener('visibilitychange', () => { if (document.hidden) stopTransport(); });
window.addEventListener('pagehide', () => stopTransport());
