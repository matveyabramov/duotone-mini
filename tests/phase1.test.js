// Phase 1 regressions and Phases 2/3 interaction tests; audio nodes are recorded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor() {
    this.children = [];
    this.events = {};
    this.attributes = {};
    this.dataset = {};
    this.style = { setProperty() {} };
    this.classList = { toggle() {} };
  }
  addEventListener(name, callback) { (this.events[name] ??= []).push(callback); }
  fire(name, event = {}) {
    for (const callback of this.events[name] ?? []) callback({ target: this, preventDefault() {}, ...event });
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(child) { this.children.push(child); }
  closest() { return null; }
  setPointerCapture() {}
  click() { this.fire("click"); }
  set innerHTML(html) {
    this.parts = {};
    for (const tag of ['input', 'output', 'span']) {
      if (!html.includes(`<${tag}`)) continue;
      const element = new Element();
      if (tag === 'input') {
        element.value = html.match(/value="([^"]+)"/)[1];
        const id = html.match(/<input id="([^"]+)"/)[1];
        elements[id] = element;
      }
      this.parts[tag] = element;
    }
  }
  querySelector(tag) { return this.parts[tag]; }
}
const elements = {};
const document = new Element();
document.getElementById = id => elements[id] ??= new Element();
document.createElement = () => new Element();
const window = new Element();
let resume;
const calls = [];
class Signal {
  constructor(value) { this.value = value; }
  rampTo(value) { this.value = value; }
}
class AudioNode {
  constructor(options) {
    this.options = options;
    this.connections = [];
    this.gain = new Signal(typeof options === 'number' ? options : 1);
    this.frequency = new Signal(options?.frequency);
    this.Q = new Signal(options?.Q);
  }
  connect(node) { this.connections.push(node); return this; }
  toDestination() { this.destination = true; return this; }
}
class PolySynth extends AudioNode {
  constructor(voice, options) { super(options); }
  triggerAttack(note) { calls.push(['attack', note]); }
  triggerRelease(note) { calls.push(['release', note]); }
  triggerAttackRelease(note, duration) { calls.push(['tap', note, duration]); }
  releaseAll() { calls.push(['releaseAll']); }
  set(options) { this.options.envelope = { ...this.options.envelope, ...options.envelope }; }
}
const drumCalls = [];
const samplerNodes = [];
let autoLoadSamples = true;
let failedFile = null;
class Sampler extends AudioNode {
  constructor(options) {
    super(options);
    samplerNodes.push(this);
    if (autoLoadSamples) queueMicrotask(() => {
      if (Object.values(options.urls).includes(failedFile)) options.onerror(new Error('Missing test sample'));
      else options.onload();
    });
  }
  triggerAttack(note) { drumCalls.push(note); }
  releaseAll() { this.released = true; }
  dispose() { this.disposed = true; }
}
const transport = { bpm: { value: 120 }, PPQ: 192, state: 'stopped', starts: 0, stops: 0, events: {},
  on(name, callback) { (this.events[name] ??= new Set()).add(callback); },
  off(name, callback) { this.events[name]?.delete(callback); },
  start() { this.starts++; this.state = 'started'; for (const fn of this.events.start ?? []) fn(); },
  stop() { this.stops++; this.state = 'stopped'; for (const fn of this.events.stop ?? []) fn(); },
  pause() { this.state = 'paused'; for (const fn of this.events.pause ?? []) fn(); }
};
const sequences = [];
const drawQueue = [];
class Sequence {
  constructor(callback, events, subdivision) {
    Object.assign(this, { callback, events, subdivision }); sequences.push(this);
  }
  start() { return this; }
  stop() { this.stopped = true; }
  dispose() { this.disposed = true; }
}
const parts = [];
class Part extends Sequence {
  constructor(callback, events) { super(callback, events); parts.push(this); }
}
const Tone = {
  getTransport: () => transport, Sequence, Part, immediate: () => 0,
  getDraw: () => ({ schedule: callback => drawQueue.push(callback) }),
  start: () => new Promise(resolve => { resume = resolve; }),
  Gain: AudioNode, Filter: AudioNode, Freeverb: AudioNode, FeedbackDelay: AudioNode,
  PolySynth, Synth: AudioNode, Sampler
};
window.Tone = Tone;
window.Midi = require("../assets/vendor/Midi.js").Midi;
const context = vm.createContext({ window, document, Tone, console, setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync('midi-import.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('script.js', 'utf8'), context);
const run = code => vm.runInContext(code, context);
const settle = () => new Promise(resolve => setImmediate(resolve));
const key = (code, repeat = false) => window.fire('keydown', { code, repeat });
const up = code => window.fire('keyup', { code });
const assertClean = () => assert.equal(run('sources.size + soundingNotes.size + latchedNotes.size'), 0);

(async () => {
  // A first tap must survive slow AudioContext startup, but a cancelled tap must not.
  key('KeyZ'); up('KeyZ'); resume(); await settle();
  assert.deepEqual(calls[0], ['tap', 'C3', .06]); assertClean();
  Tone.start = () => Promise.resolve();
  const expected = [['KeyZ','C3'],['KeyS','C#3'],['KeyX','D3'],['KeyD','D#3'],['KeyC','E3'],['KeyV','F3'],['KeyG','F#3'],['KeyB','G3'],['KeyH','G#3'],['KeyN','A3'],['KeyJ','A#3'],['KeyM','B3'],['KeyQ','C4'],['Digit2','C#4'],['KeyW','D4'],['Digit3','D#4'],['KeyE','E4'],['KeyR','F4'],['Digit5','F#4'],['KeyT','G4'],['Digit6','G#4'],['KeyY','A4'],['Digit7','A#4'],['KeyU','B4'],['KeyI','C5']];
  for (const [code, note] of expected) {
    key(code); await settle(); assert.deepEqual(calls.at(-1), ['attack', note]);
    const count = calls.length; key(code, true); key(code); await settle(); assert.equal(calls.length, count);
    up(code); assert.deepEqual(calls.at(-1), ['release', note]); assertClean();
  }
  // Polyphony and overlapping sources for one pitch must release independently.
  key('KeyQ'); key('KeyE'); key('KeyT'); await settle();
  assert.equal(run('soundingNotes.size'), 3);
  await run('noteOn("pointer:1", 12)'); up('KeyQ');
  assert.equal(run('soundingNotes.has(60)'), true);
  run('noteOff("pointer:1")'); up('KeyE'); up('KeyT'); assertClean();
  run('setHold(true)'); key('KeyQ'); await settle(); up('KeyQ');
  assert.equal(run('latchedNotes.has(60)'), true);
  run('setHold(false)'); assertClean();
  // Hold OFF releases every latch, including a note whose physical key is still down.
  run('setHold(true)'); key('KeyQ'); await settle(); run('setHold(false)');
  assert.equal(run('soundingNotes.has(60)'), false);
  assert.equal(elements.piano.children[12].attributes['aria-pressed'], 'false'); up('KeyQ'); assertClean();
  run('changeOctave(1)'); key('KeyZ'); await settle();
  assert.deepEqual(calls.at(-1), ['attack', 'C4']); run('changeOctave(-1)'); up('KeyZ'); assertClean();
  key('KeyQ'); await settle(); window.fire('blur'); assertClean();
  run('setHold(true)'); await run('noteOn("pointer:2", 12)');
  run('noteOff("pointer:2", true)'); assertClean(); run('setHold(false)');
  // Audio initialization races must not resurrect notes after losing focus.
  Tone.start = () => new Promise(resolve => { resume = resolve; });
  key('KeyQ'); window.fire('blur'); const count = calls.length; resume(); await settle();
  assert.equal(calls.length, count); assertClean(); Tone.start = () => Promise.resolve();
  // A quick startup tap followed by a held note of the same pitch must not schedule
  // a release that cuts the held note short.
  Tone.start = () => new Promise(resolve => { resume = resolve; });
  key('KeyZ'); up('KeyZ'); key('KeyZ');
  const beforeResume = calls.length; resume(); await settle();
  assert.deepEqual(calls.slice(beforeResume), [['attack', 'C3']]);
  up('KeyZ'); assertClean(); Tone.start = () => Promise.resolve();
  run('changeOctave(10)'); assert.equal(run('octave'), 2);
  run('changeOctave(-10)'); assert.equal(run('octave'), -2);
  run('changeOctave(2)');
  for (const id of ['cutoff','resonance','attack','decay','sustain','release','reverb','delay']) {
    for (const value of [0,1000]) {
      elements[id].value = value; elements[id].fire('input');
      assert.ok(Number.isFinite(run(`parameters.${id}.value`)));
    }
  }
  assert.equal(run('audio.filter.frequency.value'), 16000);
  assert.equal(run('audio.filter.Q.value'), 8);
  assert.equal(run('audio.synth.options.envelope.attack'), 2);
  assert.equal(run('audio.synth.options.envelope.release'), 6);
  assert.equal(run('audio.reverbSend.gain.value'), 1);
  assert.equal(run('audio.delaySend.gain.value'), 1);
  for (const id of ['synth','fx','master']) {
    elements[`level-${id}`].value = 0; elements[`level-${id}`].fire('input');
  }
  assert.equal(run('audio.synthLevel.gain.value'), 0);
  assert.equal(run('audio.fxLevel.gain.value'), 0);
  assert.equal(run('audio.master.gain.value'), 0);
  assert.equal(run('audio.synthLevel.connections.includes(audio.master)'), true);
  assert.equal(run('audio.synthLevel.connections.includes(audio.reverb)'), true);
  assert.equal(run('audio.synthLevel.connections.includes(audio.delay)'), true);
  assert.equal(run('audio.fxLevel.connections.includes(audio.master)'), true);
  console.log('PASS: 25 mappings, repeat suppression, chords, overlapping inputs, Hold, octave, blur, pointer cancellation, startup races, 8 parameters, and 3 mixer routes.');
  // Drum-only first interaction reuses initialization, with its own master input.
  run('audio = null');
  await run('triggerDrum(0)');
  assert.equal(drumCalls.at(-1), 'C1');
  assert.equal(run('audio.drumLevel.connections.length'), 1);
  assert.equal(run('audio.drumLevel.connections[0] === audio.master'), true);
  for (let index = 1; index < 8; index++) await run(`triggerDrum(${index})`);
  assert.equal(new Set(drumCalls).size, 8);
  assert.equal(samplerNodes.length, 8);
  assert.equal(samplerNodes.every(node => node.connections.length === 1), true);
  assert.equal(run('drumVoices.every(voice => voice.sampler.connections[0] === audio.drumLevel)'), true);
  // Real pointer events: press, release, cancellation, and ghost-click suppression.
  const pad = elements.pads.children[1];
  const beforePad = drumCalls.length;
  pad.fire('pointerdown', { button: 0, pointerId: 7, pointerType: 'touch' });
  assert.equal(pad.attributes['aria-pressed'], 'true');
  pad.fire('pointerup', { pointerId: 7 });
  pad.fire('click', { detail: 1 });
  await settle();
  assert.equal(drumCalls.length, beforePad + 1);
  assert.equal(run('padStates[1].pressed.size'), 0);
  run('stopDrums()');
  assert.equal(pad.attributes['aria-pressed'], 'false');
  // Rapid hits after load are not blocked by the previous sample or visual flash.
  const beforeRapid = drumCalls.length;
  for (let i = 0; i < 12; i++) await run('triggerDrum(0)');
  assert.equal(drumCalls.length, beforeRapid + 12);
  // Hold and octave transpose only the synth, even during drum playback.
  run('setHold(true); changeOctave(1)');
  await run('triggerDrum(0)'); assert.equal(drumCalls.at(-1), 'C1');
  key('KeyZ'); await settle(); assert.deepEqual(calls.at(-1), ['attack', 'C4']);
  up('KeyZ'); run('setHold(false); changeOctave(-1)'); assertClean();
  // Multiple requests during loading produce only the latest hit, with no backlog.
  run('drumVoices[2].sampler.dispose(); drumVoices[2] = null');
  autoLoadSamples = false;
  const pending = [run('triggerDrum(2)'), run('triggerDrum(2)'), run('triggerDrum(2)')];
  await settle();
  const delayedSampler = samplerNodes.at(-1);
  const beforeLoading = drumCalls.length;
  delayedSampler.options.onload(); await Promise.all(pending);
  assert.equal(drumCalls.length, beforeLoading + 1);
  // A cancelled touch cannot trigger later when its sample arrives.
  run('drumVoices[3].sampler.dispose(); drumVoices[3] = null');
  const touchPad = elements.pads.children[3];
  touchPad.fire('pointerdown', { button: 0, pointerId: 9, pointerType: 'touch' });
  await settle();
  touchPad.fire('pointercancel', { pointerId: 9 });
  const beforeCancellation = drumCalls.length;
  samplerNodes.at(-1).options.onload(); await settle();
  assert.equal(drumCalls.length, beforeCancellation);
  assert.equal(touchPad.attributes['aria-pressed'], 'false');
  // Stop invalidates asynchronous pending hits and releases both voices.
  run('drumVoices[4].sampler.dispose(); drumVoices[4] = null');
  const pendingStop = run('triggerDrum(4)'); await settle();
  elements.stop.fire('click');
  const beforeStop = drumCalls.length;
  samplerNodes.at(-1).options.onload(); await pendingStop;
  assert.equal(drumCalls.length, beforeStop); assertClean();
  // A failed pad remains retryable and does not affect another sampler or synth.
  autoLoadSamples = true;
  run('drumVoices[5].sampler.dispose(); drumVoices[5] = null');
  failedFile = 'LT3D7.WAV';
  await run('triggerDrum(5)');
  assert.equal(run('drumVoices[5].state'), 'failed');
  assert.ok(elements.readout.textContent.includes('SAMPLE UNAVAILABLE'));
  await run('triggerDrum(6)'); assert.equal(drumCalls.at(-1), 'G1');
  failedFile = null; await run('triggerDrum(5)');
  assert.equal(run('drumVoices[5].state'), 'ready');
  elements['level-drums'].value = 0; elements['level-drums'].fire('input');
  assert.equal(run('audio.drumLevel.gain.value'), 0);
  assert.equal(run('audio.synthLevel.gain.value'), run('levels.synth'));
  elements['level-synth'].value = 80; elements['level-synth'].fire('input');
  assert.equal(run('audio.drumLevel.gain.value'), 0);
  assert.equal(run('audio.synthLevel.gain.value'), .8);
  // OLED returns to the current synth readout, including when controls interrupt it.
  run('display()');
  assert.equal(elements['oled-voice'].textContent, 'VOICE A · POLY SYNTH');
  window.fire('blur');
  assert.equal(run('padStates.every(state => state.pressed.size === 0 && !state.flashing)'), true);
  assertClean();
  console.log('PASS: 8 independent samples, first-pad startup, touch handlers, pressed states, rapid retriggers, loading coalescing, cancellation, Stop, failure/retry, gain isolation, and OLED restoration.');

  // One bar contains eight hats, two kicks and two snares, with no duplicate loop.
  await run('startTransport()');
  const groove = sequences.at(-1);
  assert.equal(elements.play.attributes['aria-pressed'], 'true');
  assert.equal(groove.subdivision, '8n');
  const beforeGroove = drumCalls.length;
  for (let step = 0; step < 8; step++) groove.callback(step * .25, step);
  assert.deepEqual(drumCalls.slice(beforeGroove), ['F#1','C1','F#1','F#1','D1','F#1','F#1','C1','F#1','F#1','D1','F#1']);
  const sequenceCount = sequences.length, starts = transport.starts;
  await run('startTransport()'); await run('startTransport()');
  assert.equal(sequences.length, sequenceCount); assert.equal(transport.starts, starts);
  drawQueue.splice(0).forEach(callback => callback());
  assert.equal(elements.pads.children[0].attributes['aria-pressed'], 'true');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(elements.pads.children.every(pad => pad.attributes['aria-pressed'] === 'false'), true);
  // A held pad is still a finite flash, not a selection.
  elements.pads.children[0].fire('pointerdown', { button: 0, pointerId: 88 });
  await settle(); await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(elements.pads.children[0].attributes['aria-pressed'], 'false');
  elements.pads.children[0].fire('pointerup', { pointerId: 88 });
  key('KeyQ'); await settle(); assert.equal(run('soundingNotes.size'), 1);
  const hits = drumCalls.length;
  await run('triggerDrum(7)'); assert.equal(drumCalls.length, hits + 1);
  up('KeyQ'); assertClean();
  elements.bpm.value = '170'; elements.bpm.fire('change'); assert.equal(transport.bpm.value, 170);
  elements.bpm.fire('keydown', { code: 'ArrowUp' }); assert.equal(transport.bpm.value, 171);
  run('setBpm(999)'); assert.equal(transport.bpm.value, 200);
  run('setBpm(1)'); assert.equal(transport.bpm.value, 50);
  run('setBpm(120)');
  groove.callback(2, 0);
  run('setHold(true)'); elements.stop.fire('click');
  assert.equal(run('hold'), true);
  assert.equal(elements.play.attributes['aria-pressed'], 'false');
  assert.ok(groove.disposed);
  const stoppedHits = drumCalls.length;
  groove.callback(2.25, 1); drawQueue.splice(0).forEach(callback => callback());
  assert.equal(drumCalls.length, stoppedHits);
  assert.equal(elements.pads.children.every(pad => pad.attributes['aria-pressed'] === 'false'), true);
  await run('triggerDrum(0)'); key('KeyZ'); await settle(); up('KeyZ');
  run('setHold(false)'); assertClean();
  // Stop while samples are loading must not start a transport later.
  run('drumVoices[0].sampler.dispose(); drumVoices[0] = null');
  autoLoadSamples = false;
  const waitingPlay = run('startTransport()'); await settle();
  const pendingSampler = samplerNodes.at(-1);
  run('stopTransport()'); pendingSampler.options.onload(); await waitingPlay;
  assert.equal(transport.starts, starts);
  autoLoadSamples = true;
  await run('startTransport()'); assert.equal(transport.starts, starts + 1);
  window.fire('blur'); assert.equal(run('sequence'), null);
  assertClean();
  const css = fs.readFileSync('style.css', 'utf8');
  assert.ok(!css.includes('.pad:first-child'));
  assert.ok(css.includes('button:focus-visible'));
  console.log('PASS: neutral pads, transient manual/sequence flashes, groove hit counts, duplicate Play guard, live instruments, BPM/range/arrows, Stop cleanup, preserved Hold, loading cancellation, and restart.');

  // The real bundled parser reads binary files; only audio scheduling is mocked.
  const fixture = name => {
    const data = fs.readFileSync(`tests/fixtures/${name}`);
    return { name, size: data.length, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  };
  context.file = fixture('melody.mid');
  assert.equal(await run('importMidiFile(file)'), true);
  assert.equal(run('importedMidi.trackName'), 'Lead');
  assert.equal(run('importedMidi.notes.length'), 5);
  assert.equal(run('importedMidi.tempoChanges'), 2);
  assert.ok(Math.abs(run('bpm') - 132) < .001);
  assert.ok(elements.readout.textContent.includes('INITIAL TEMPO'));
  await run('startTransport()');
  const midiSequence = parts.at(-1);
  assert.equal(midiSequence.events.length, 10);
  assert.equal(midiSequence.loop, false);
  assert.equal(midiSequence.events[0].time, '0i');
  const countBeforePlay = parts.length;
  await run('startTransport()'); assert.equal(parts.length, countBeforePlay);
  const firstOn = midiSequence.events.find(event => event.on && event.note.midi === 60);
  const firstOff = midiSequence.events.find(event => !event.on && event.note.id === firstOn.note.id);
  midiSequence.callback(0, firstOn); drawQueue.splice(0).forEach(fn => fn());
  assert.equal(elements.piano.children[12].attributes['aria-pressed'], 'true');
  const beforeShared = calls.length;
  key('KeyQ'); await settle(); assert.equal(calls.length, beforeShared);
  midiSequence.callback(.5, firstOff); drawQueue.splice(0).forEach(fn => fn());
  assert.equal(calls.length, beforeShared); // MIDI release leaves the manual pitch held.
  assert.equal(elements.piano.children[12].attributes['aria-pressed'], 'true');
  up('KeyQ'); assert.deepEqual(calls.at(-1), ['release', 'C4']);
  const highOn = midiSequence.events.find(event => event.on && event.note.midi === 84);
  midiSequence.callback(.6, highOn); drawQueue.splice(0).forEach(fn => fn());
  assert.deepEqual(calls.at(-1), ['attack', 'C6']);
  assert.equal(elements.piano.children.every(key => key.attributes['aria-pressed'] === 'false'), true);
  // Octave and Hold release only manual ownership, not the imported pitches.
  run('changeOctave(1)'); assert.equal(run('midiPitchCounts.has(84)'), true);
  const beforeOctave = calls.length;
  key('KeyZ'); await settle(); assert.deepEqual(calls.at(-1), ['attack', 'C4']); up('KeyZ');
  run('changeOctave(-1)'); assert.equal(run('midiPitchCounts.has(84)'), true);
  assert.ok(calls.length > beforeOctave);
  const drumCountDuringMidi = drumCalls.length;
  await run('triggerDrum(2)'); assert.equal(drumCalls.length, drumCountDuringMidi + 1);
  // External Transport.stop/pause events also clear the UI and all owned schedules.
  transport.stop();
  assert.equal(elements.play.attributes['aria-pressed'], 'false');
  assert.equal(run('midiPart'), null); assert.equal(midiSequence.disposed, true);
  assert.equal(run('midiPitchCounts.size + midiVisualNotes.size'), 0);
  assert.equal(transport.position, 0);
  const oldGeneration = run('transportGeneration');
  midiSequence.callback(1, firstOn); drawQueue.splice(0).forEach(fn => fn());
  assert.equal(run('midiPitchCounts.size'), 0);
  await run('startTransport()'); assert.equal(parts.length, countBeforePlay + 1);
  assert.ok(run('transportGeneration') > oldGeneration);
  transport.pause(); assert.equal(elements.play.attributes['aria-pressed'], 'false');
  await run('startTransport()');
  const replacedPart = parts.at(-1);
  context.file = fixture('replacement.midi');
  assert.equal(await run('importMidiFile(file)'), true);
  assert.equal(replacedPart.disposed, true);
  assert.equal(run('importedMidi.notes.length'), 2);
  assert.ok(Math.abs(run('bpm') - 132) < .001); // Missing tempo preserves current BPM.
  assert.equal(elements.play.attributes['aria-pressed'], 'false');
  const retained = run('importedMidi');
  for (const name of ['invalid.mid', 'truncated.mid', 'drum-only.mid']) {
    context.file = fixture(name);
    assert.equal(await run('importMidiFile(file)'), false);
    assert.equal(run('importedMidi'), retained);
    assert.equal(elements['oled-voice'].textContent, 'MIDI IMPORT FAILED');
  }
  // First MIDI tempo is preserved even outside the usual manual tempo range.
  context.file = fixture('tempo-240.mid');
  await run('importMidiFile(file)'); assert.equal(run('bpm'), 240);
  assert.equal(elements.bpm.max, 240);
  context.file = fixture('melody.mid'); await run('importMidiFile(file)');
  // Overlapping imported notes at the same pitch share a gate until both end.
  await run('startTransport()');
  const overlapPart = parts.at(-1);
  const samePitch = overlapPart.events.filter(event => event.note.midi === 60);
  overlapPart.callback(0, samePitch[0]); overlapPart.callback(.2, samePitch[1]);
  assert.equal(run('midiPitchCounts.get(60)'), 2);
  const beforeFirstOff = calls.length;
  overlapPart.callback(.4, samePitch[2]); assert.equal(calls.length, beforeFirstOff);
  assert.equal(run('midiPitchCounts.get(60)'), 1);
  overlapPart.callback(.6, samePitch[3]); assert.deepEqual(calls.at(-1), ['release', 'C4']);
  run('stopTransport()'); drawQueue.splice(0).forEach(fn => fn()); assertClean();
  assert.equal(run('midiVisualNotes.size'), 0);
  // True manual latch: build C/E/G, then independently toggle C and E off.
  run('setHold(true)');
  for (const code of ['KeyQ', 'KeyE', 'KeyT']) { key(code); await settle(); up(code); }
  assert.equal(run('latchedNotes.size'), 3);
  assert.equal(run('soundingNotes.size'), 3);
  const chordCalls = calls.length;
  key('KeyQ'); await settle();
  assert.deepEqual(calls.slice(chordCalls), [['release', 'C4']]);
  assert.equal(elements.piano.children[12].attributes['aria-pressed'], 'false');
  key('KeyQ', true); key('KeyQ'); await settle();
  assert.equal(calls.length, chordCalls + 1);
  up('KeyQ'); assert.equal(run('latchedNotes.size'), 2);
  key('KeyE'); await settle(); up('KeyE');
  assert.equal(run('latchedNotes.size'), 1);
  assert.equal(run('latchedNotes.has(67)'), true);
  run('setHold(false)'); assertClean();
  // Keyboard and pointer toggle the same musical pitch, not separate latches.
  run('setHold(true)'); key('KeyQ'); await settle();
  const touchLatch = elements.piano.children[12];
  touchLatch.fire('pointerdown', { button: 0, pointerId: 44, pointerType: 'touch' });
  await settle(); assert.equal(run('latchedNotes.has(60)'), false);
  assert.equal(touchLatch.attributes['aria-pressed'], 'false');
  touchLatch.fire('pointerup', { pointerId: 44 }); up('KeyQ'); assertClean();
  // Octave changes preserve latches and currently pressed notes at original pitches.
  key('KeyQ'); await settle(); up('KeyQ');
  const octaveCalls = calls.length;
  run('changeOctave(1)');
  assert.equal(calls.length, octaveCalls);
  assert.equal(run('latchedNotes.has(60)'), true);
  assert.equal(elements.piano.children[0].attributes['aria-pressed'], 'true');
  key('KeyE'); await settle(); up('KeyE');
  assert.equal(run('latchedNotes.has(76)'), true);
  // Z now maps to the original C4, so it can unlatch Q's old musical pitch.
  key('KeyZ'); await settle(); up('KeyZ');
  assert.equal(run('latchedNotes.has(60)'), false);
  assert.equal(run('latchedNotes.has(76)'), true);
  elements.stop.fire('click');
  assert.equal(run('hold'), true); assertClean();
  assert.equal(elements.piano.children.every(key => key.attributes['aria-pressed'] === 'false'), true);
  run('changeOctave(-1); setHold(false)');
  key('KeyZ'); await settle(); run('changeOctave(1)');
  assert.equal(run('soundingNotes.has(48)'), true);
  assert.equal(elements.piano.children[0].attributes['aria-pressed'], 'false');
  up('KeyZ'); assertClean(); run('changeOctave(-1)');
  // Slow audio startup: two latch taps cancel, and Hold OFF/Stop cancel pending latches.
  Tone.start = () => new Promise(resolve => { resume = resolve; });
  run('setHold(true)'); key('KeyQ'); up('KeyQ'); key('KeyQ'); up('KeyQ');
  const beforeLatchResume = calls.length; resume(); await settle();
  assert.equal(calls.length, beforeLatchResume); assertClean();
  key('KeyE'); up('KeyE'); run('setHold(false)');
  const beforeDisabledResume = calls.length; resume(); await settle();
  assert.equal(calls.length, beforeDisabledResume); assertClean();
  run('setHold(true)'); key('KeyT'); up('KeyT'); elements.stop.fire('click');
  const beforePanicResume = calls.length; resume(); await settle();
  assert.equal(calls.length, beforePanicResume); assertClean();
  Tone.start = () => Promise.resolve();
  // MIDI duration and visual ownership remain independent of manual latch toggles.
  await run('startTransport()');
  const heldMidiPart = parts.at(-1);
  const midiC = heldMidiPart.events.find(event => event.on && event.note.midi === 60);
  const midiCOff = heldMidiPart.events.find(event => !event.on && event.note.id === midiC.note.id);
  heldMidiPart.callback(0, midiC); drawQueue.splice(0).forEach(fn => fn());
  key('KeyQ'); await settle(); up('KeyQ');
  assert.equal(run('latchedNotes.has(60)'), true);
  const beforeMidiRelease = calls.length;
  heldMidiPart.callback(.5, midiCOff); drawQueue.splice(0).forEach(fn => fn());
  assert.equal(run('midiPitchCounts.has(60)'), false);
  assert.equal(run('midiVisualNotes.size'), 0);
  assert.equal(calls.length, beforeMidiRelease);
  assert.equal(elements.piano.children[12].attributes['aria-pressed'], 'true');
  key('KeyQ'); await settle(); up('KeyQ');
  assert.equal(run('soundingNotes.size'), 0);
  assert.equal(elements.piano.children[12].attributes['aria-pressed'], 'false');
  heldMidiPart.callback(.6, midiC); drawQueue.splice(0).forEach(fn => fn());
  key('KeyQ'); await settle(); up('KeyQ'); run('setHold(false)');
  assert.equal(run('midiPitchCounts.has(60)'), true);
  assert.equal(elements.piano.children[12].attributes['aria-pressed'], 'true');
  heldMidiPart.callback(1.1, midiCOff); drawQueue.splice(0).forEach(fn => fn());
  assert.equal(elements.piano.children[12].attributes['aria-pressed'], 'false');
  run('setHold(true)'); await run('triggerDrum(0)');
  assert.equal(run('latchedNotes.size'), 0);
  assert.equal(drumCalls.at(-1), 'C1');
  run('stopTransport()'); assertClean();
  for (let cycle = 0; cycle < 4; cycle++) {
    const startsBeforeCycle = transport.starts, partsBeforeCycle = parts.length;
    await run('startTransport()'); await run('startTransport()');
    assert.equal(transport.starts, startsBeforeCycle + 1);
    assert.equal(parts.length, partsBeforeCycle + 1);
    key('KeyQ'); await settle(); up('KeyQ');
    assert.equal(run('latchedNotes.has(60)'), true);
    run('stopTransport()'); assertClean();
    assert.equal(run('midiPart === null && sequence === null'), true);
    assert.equal(elements.play.attributes['aria-pressed'], 'false');
    assert.equal(run('padStates.every(state => !state.flashing)'), true);
  }
  run('setHold(false)');
  console.log('PASS: per-pitch latch chord/toggle, cross-input toggles, repeat suppression, Hold OFF, octave retention, startup cancellation, panic, independent MIDI ownership/duration, drums ignoring Hold, and four duplicate-free transport restarts.');
  const formatOne = fs.readFileSync('tests/fixtures/replacement.midi');
  const formatZero = Buffer.concat([formatOne.subarray(0, 14), formatOne.subarray(22 + formatOne.readUInt32BE(18))]);
  formatZero.writeUInt16BE(0, 8); formatZero.writeUInt16BE(1, 10); context.binary = formatZero;
  assert.equal(run('parseMidi(binary, "format-zero.mid").notes.length'), 2);
  const unsupported = Buffer.from(formatZero); unsupported.writeUInt16BE(2, 8); context.binary = unsupported;
  assert.throws(() => run('parseMidi(binary, "format-two.mid")'), /UNSUPPORTED MIDI FORMAT/);
  unsupported.writeUInt16BE(0, 8); unsupported.writeUInt16BE(0xE728, 12);
  assert.throws(() => run('parseMidi(binary, "smpte.mid")'), /UNSUPPORTED MIDI FORMAT/);
  // A later import wins even if an earlier File read finishes last.
  let finishFile;
  context.slowFile = { name: 'slow.mid', size: 200, arrayBuffer: () => new Promise(resolve => { finishFile = resolve; }) };
  const pendingImport = run('importMidiFile(slowFile)');
  context.file = fixture('replacement.midi'); await run('importMidiFile(file)');
  finishFile(await fixture('melody.mid').arrayBuffer()); await pendingImport;
  assert.equal(run('importedMidi.filename'), 'replacement.midi');
  const css4 = fs.readFileSync('style.css', 'utf8');
  assert.ok(!css4.includes('.play-button img'));
  assert.ok(!css4.includes('#stop[aria-pressed'));
  console.log('PASS: real MIDI parsing, melodic track selection, initial/missing tempo, tick scheduling, key highlights, out-of-range audio, shared manual/MIDI pitches, octave independence, external stop/pause, restart, replacement, invalid files, overlaps, and import races.');

})().catch(error => { console.error(error); process.exitCode = 1; });
