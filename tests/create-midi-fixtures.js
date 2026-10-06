// Small deterministic Standard MIDI files for parser and browser regression checks.
const fs = require('node:fs');
const path = require('node:path');
const { Midi } = require('../assets/vendor/Midi.js');
const directory = path.join(__dirname, 'fixtures');
fs.mkdirSync(directory, { recursive: true });
function save(name, midi) { fs.writeFileSync(path.join(directory, name), midi.toArray()); }
const melody = new Midi();
melody.header.tempos = [{ ticks: 0, bpm: 132 }, { ticks: 960, bpm: 96 }];
melody.header.update();
melody.addTrack().name = 'Empty';
const drums = melody.addTrack();
drums.name = 'Percussion'; drums.channel = 9;
for (let i = 0; i < 12; i++) drums.addNote({ midi: 36, ticks: i * 120, durationTicks: 60, velocity: .8 });
const lead = melody.addTrack(); lead.name = 'Lead';
for (const [midi, ticks, durationTicks] of [[60,0,480],[64,0,480],[60,240,480],[84,480,240],[67,960,480]]) {
  lead.addNote({ midi, ticks, durationTicks, velocity: .65 });
}
const bass = melody.addTrack(); bass.name = 'Bass';
bass.addNote({ midi: 36, ticks: 0, durationTicks: 480 }).addNote({ midi: 43, ticks: 480, durationTicks: 480 });
save('melody.mid', melody);
const replacement = new Midi();
replacement.addTrack().addNote({ midi: 72, ticks: 0, durationTicks: 480, velocity: .7 })
  .addNote({ midi: 77, ticks: 480, durationTicks: 480, velocity: .5 });
save('replacement.midi', replacement);
const slow = new Midi(); slow.header.setTempo(80);
slow.addTrack().addNote({ midi: 60, ticks: 0, durationTicks: 1920, velocity: .6 });
save('sustained.mid', slow);
const fast = new Midi(); fast.header.setTempo(240);
fast.addTrack().addNote({ midi: 60, ticks: 0, durationTicks: 480 });
save('tempo-240.mid', fast);
const percussion = new Midi(); const drumTrack = percussion.addTrack(); drumTrack.channel = 9;
drumTrack.addNote({ midi: 36, ticks: 0, durationTicks: 120 }); save('drum-only.mid', percussion);
fs.writeFileSync(path.join(directory, 'invalid.mid'), 'This is not a MIDI file.');
fs.writeFileSync(path.join(directory, 'truncated.mid'), melody.toArray().slice(0, -5));
console.log('Created seven MIDI validation fixtures.');
