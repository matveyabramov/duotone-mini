'use strict';

// One imported melodic track, played once per transport start by the existing synth.
let importedMidi = null;
let midiPart = null;
let importRequest = 0;
const midiPitchCounts = new Map();
const midiVisualNotes = new Map();

function parseMidi(buffer, filename) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 14 || tag(0) !== 'MThd' || view.getUint32(4) !== 6) throw new Error('INVALID MIDI FILE');
  const format = view.getUint16(8), tracks = view.getUint16(10), division = view.getUint16(12);
  if (format > 1 || !division || division & 0x8000) throw new Error('UNSUPPORTED MIDI FORMAT');
  if (!tracks || (format === 0 && tracks !== 1)) throw new Error('INVALID MIDI FILE');
  let offset = 14;
  for (let i = 0; i < tracks; i++) {
    if (offset + 8 > bytes.length || tag(offset) !== 'MTrk') throw new Error('INCOMPLETE MIDI FILE');
    offset += 8 + view.getUint32(offset + 4);
    if (offset > bytes.length) throw new Error('INCOMPLETE MIDI FILE');
  }
  if (!window.Midi) throw new Error('MIDI PARSER UNAVAILABLE');
  const parsed = new window.Midi(bytes);
  const candidates = parsed.tracks.map((track, index) => ({
    track, index,
    notes: track.notes.filter(note => Number.isInteger(note.midi) && note.midi >= 0 && note.midi <= 127 &&
      Number.isFinite(note.ticks) && note.ticks >= 0 && Number.isFinite(note.durationTicks) && note.durationTicks > 0 &&
      Number.isFinite(note.velocity) && note.velocity > 0 && Number.isFinite(note.time) && Number.isFinite(note.duration))
  })).filter(({ track, notes }) => notes.length && track.channel !== 9 && !track.instrument.percussion);
  candidates.sort((a, b) => b.notes.length - a.notes.length || a.index - b.index);
  if (!candidates.length) throw new Error('NO MELODIC NOTES');
  const selected = candidates[0];
  if (selected.notes.length > 50000) throw new Error('MIDI HAS TOO MANY NOTES');
  const tempos = parsed.header.tempos.filter(tempo => Number.isFinite(tempo.bpm) && tempo.bpm >= 1 && tempo.bpm <= 1000)
    .sort((a, b) => a.ticks - b.ticks);
  return {
    filename, trackName: selected.track.name || `Track ${selected.index + 1}`,
    trackIndex: selected.index, channel: selected.track.channel, ppq: parsed.header.ppq,
    tempo: tempos[0]?.bpm ?? null, tempoChanges: tempos.length,
    notes: selected.notes.map((note, id) => ({ id, midi: note.midi, ticks: note.ticks,
      durationTicks: note.durationTicks, time: note.time, duration: note.duration,
      velocity: Math.min(1, note.velocity) }))
  };
}

function importFeedback(title, filename, detail) {
  clearTimeout(oledTimer);
  document.getElementById('oled-voice').textContent = title;
  document.getElementById('oled-title').textContent = filename;
  readout.textContent = detail;
  oledTimer = setTimeout(display, 4000);
}
async function importMidiFile(file) {
  if (!file) return false;
  const request = ++importRequest;
  try {
    if (!/\.midi?$/i.test(file.name)) throw new Error('CHOOSE A .MID OR .MIDI FILE');
    if (file.size > 5 * 1024 * 1024) throw new Error('MIDI FILE TOO LARGE (MAX 5 MB)');
    const buffer = await file.arrayBuffer();
    if (request !== importRequest) return false;
    const next = parseMidi(buffer, file.name);
    // Validate before replacing: a bad import leaves the previous melody available.
    stopTransport();
    importedMidi = next;
    if (next.tempo !== null) setBpm(next.tempo);
    const tempoInfo = next.tempoChanges > 1 ? ' · INITIAL TEMPO' : '';
    importFeedback('MIDI IMPORTED', next.filename, `${next.notes.length} NOTES · ${bpm.toFixed(1)} BPM${tempoInfo}`);
    return true;
  } catch (error) {
    if (request === importRequest) importFeedback('MIDI IMPORT FAILED', file.name, error.message?.startsWith('MIDI') ||
      ['INVALID MIDI FILE', 'UNSUPPORTED MIDI FORMAT', 'INCOMPLETE MIDI FILE', 'NO MELODIC NOTES', 'CHOOSE A .MID OR .MIDI FILE'].includes(error.message)
      ? error.message : 'FILE COULD NOT BE READ');
    return false;
  }
}

function scheduleMidi(generation, transport) {
  if (!importedMidi) return;
  const events = [];
  for (const note of importedMidi.notes) {
    const tick = Math.round(note.ticks * transport.PPQ / importedMidi.ppq);
    const end = Math.max(tick + 1, Math.round((note.ticks + note.durationTicks) * transport.PPQ / importedMidi.ppq));
    events.push({ time: `${tick}i`, tick, on: true, note });
    events.push({ time: `${end}i`, tick: end, on: false, note });
  }
  // Release before a new attack at an equal tick; overlapping pitches use counts.
  events.sort((a, b) => a.tick - b.tick || Number(a.on) - Number(b.on));
  midiPart = new Tone.Part((time, event) => playMidiEvent(event, time, generation), events).start(0);
  midiPart.loop = false;
}
function playMidiEvent(event, time, generation) {
  if (generation !== transportGeneration || transportState !== 'playing') return;
  const { note, on } = event;
  const count = midiPitchCounts.get(note.midi) || 0;
  // Sharing one gate for an overlapping pitch prevents a MIDI note-off from
  // cutting a manually held note (and vice versa) within this one PolySynth.
  if (on) {
    midiPitchCounts.set(note.midi, count + 1);
    if (!count && !soundingNotes.has(note.midi)) audio.synth.triggerAttack(noteName(note.midi), time, note.velocity);
  } else {
    if (count > 1) midiPitchCounts.set(note.midi, count - 1);
    else {
      midiPitchCounts.delete(note.midi);
      if (!soundingNotes.has(note.midi)) audio.synth.triggerRelease(noteName(note.midi), time);
    }
  }
  Tone.getDraw().schedule(() => {
    if (generation !== transportGeneration || transportState !== 'playing') return;
    if (on) {
      midiVisualNotes.set(note.id, note.midi);
      lastNote = `MIDI ${noteName(note.midi)}`;
      display();
    } else midiVisualNotes.delete(note.id);
    refreshKeys();
  }, time);
}
function clearMidiPlayback() {
  midiPart?.dispose();
  midiPart = null;
  for (const midi of midiPitchCounts.keys()) audio?.synth.triggerRelease(noteName(midi), Tone.immediate());
  midiPitchCounts.clear();
  midiVisualNotes.clear();
  refreshKeys();
}
