# DUOTONE MINI

A dual-voice browser instrument course project, built with plain HTML, CSS, JavaScript and Tone.js. **Phases 1–4 implement the polyphonic synth, eight drum samplers, backing groove, and MIDI import.**

## Run locally

From this folder, run:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open http://127.0.0.1:8000. Play a piano key or drum pad to start browser audio. Tone.js 15.1.22, @tonejs/midi 2.0.28, the drum recordings, Figma exports, and Inter / IBM Plex Mono fonts are bundled locally; no installation, build step, or network connection is needed.

## Playing

Click or touch the piano keys, or use the physical computer keys below. The displayed piano note names follow the current octave; the physical mapping stays fixed, including on non-English keyboard layouts.

| Notes | Computer keys |
| --- | --- |
| C3 C♯3 D3 D♯3 E3 F3 F♯3 G3 G♯3 A3 A♯3 B3 | Z S X D C V G B H N J M |
| C4 C♯4 D4 D♯4 E4 F4 F♯4 G4 G♯4 A4 A♯4 B4 C5 | Q 2 W 3 E R 5 T 6 Y 7 U I |

- **Hold** latches manual synth pitches on the first press; pressing the same musical pitch again releases only that latch. Other notes add to the chord. Turning Hold off releases all latches, even if a physical key is still down. Hold starts off and never changes MIDI durations or drum one-shots.
- **Oct− / Oct+** transpose the piano and computer keys together, within ±2 octaves. Existing manual notes and latches keep their original pitch; new presses use the new octave. A latched note outside the displayed range keeps sounding without a visible key.
- **Stop** releases synth notes and drum tails, cancels pending drum hits, without changing Hold or any instrument settings. Both voices release when the page loses focus or becomes hidden.
- Drag a knob up/right to increase, down/left to decrease. Focused knobs also accept arrow keys, Home, and End. Piano buttons support Space / Enter for accessibility.
- Drag the vertical faders to adjust levels. Their bottom position fully mutes that channel. Computer melody keys are ignored while a range input has focus so they do not interfere with editing controls.
- **Drum pads** play finite one-shots on mouse/touch press. Space / Enter also work when a pad is focused. Lifting a pad lets its sample tail finish. Pad note metadata never changes with synth octave.
- On narrow screens the control sections reflow and the full piano scrolls horizontally.

## Voice A and controls

Voice A is a 32-voice `Tone.PolySynth(Tone.Synth)` with a sawtooth oscillator and a shared low-pass filter. Per-voice headroom is −18 dB, with note velocity 0.8. The initial patch uses the parameter values shown in Figma.

| Control | Range |
| --- | --- |
| Cutoff | 80 Hz–16 kHz, logarithmic |
| Resonance | 0–100%, mapped to filter Q 0.5–8 |
| Attack | 2 ms–2 s, logarithmic |
| Decay | 20 ms–3 s, logarithmic |
| Sustain | 0–100% |
| Release | 30 ms–6 s, logarithmic |
| Reverb / Delay | 0–100% wet return levels |

Signal flow: synth → low-pass filter → Synth fader → dry Master input plus parallel Freeverb and FeedbackDelay returns → FX fader → Master. Gain/filter changes are smoothed. Delay is fixed at 250 ms with 28% feedback. The editable BPM readout starts at 120 and controls Transport from 50–200 BPM. Commit an edit with Enter or by leaving the field; Up/Down adjusts the focused value immediately.

## Voice B and sample configuration

`drumSamples` and `drumSampleBaseUrl` near the top of `script.js` centralize the eight mappings. The original WAV recordings are copied from the teacher's course `tutorial_4/roland_tr_909/` folder; no random pack or additional dependency is used. See [sample provenance](assets/audio/README.md).

| Pad | Metadata / sampler root | Local file | Recording |
| --- | --- | --- | --- |
| Kick | C1 | `BT7A0D0.WAV` | TR-909 bass drum |
| Snare | D1 | `ST0T3S7.WAV` | TR-909 snare |
| Clap | D♯1 | `HANDCLP1.WAV` | TR-909 handclap |
| Closed HH | F♯1 | `HHCD6.WAV` | TR-909 closed hi-hat |
| Open HH | A♯1 | `HHOD6.WAV` | TR-909 open hi-hat |
| Low tom | F1 | `LT3D7.WAV` | TR-909 low tom |
| Perc | G1 | `RIM127.WAV` | TR-909 rimshot |
| Texture | C2 | `CSHD6.WAV` | TR-909 crash cymbal |

Each pad uses a single-sample `Tone.Sampler`, playing its recording at its original pitch. This isolates loading errors to that pad. All eight samplers connect to one independent Drum Gain, then the shared Master. They have −6 dB sampler headroom and use velocity 0.9. Synth filter, envelope, Hold, octave, and FX changes do not affect drums; the FX fader remains Voice A's wet-return level.

Samples load lazily on the first press of their pad, after the same `ensureAudio()` used by the synth. The OLED shows loading or unavailable status. A first hit waits for its sample; repeated requests during loading keep only the latest hit for that pad. Loaded pads retrigger on every press. Failed loads remain retryable on the next press, with a 15-second timeout for stalled loads. Stop, focus loss, and cancelled pointers invalidate pending hits. Drum feedback returns to the current synth readout after 1.4 seconds, or immediately when a synth parameter/note changes.

All eight pads are neutral at idle and briefly flash blue on a trigger. Keyboard focus has its own outline; no pad has a selected state.

## Not implemented yet

There is no audio-file import/analysis, physical MIDI controller support, automatic composition, arrangement, additional kit, or preset system.

## Validation

Run the dependency-free interaction tests:

```sh
node tests/phase1.test.js
```

The interaction tests retain all synth regressions and also check drum-only startup, eight mappings, touch pointer handlers, pressed states, rapid retriggering, coalesced loading hits, cancelled hits, Stop, missing-sample retry, independent gain routing, and OLED restoration using recorded nodes.

For real Tone.js audio rendering checks, open [the browser validation page](http://127.0.0.1:8000/tests/browser-audio.html) and press **Run audio checks**. It builds the production audio graph in offline contexts and checks all eight non-silent/distinct waveforms, rapid retriggering, Synth/Drums isolation, Master scaling/muting, and missing-file recovery. The fixture intentionally requests one nonexistent sample to test that failure path; it confirms there are no uncaught errors or unhandled rejections.

Browser interaction checks covered all eight mouse pads, repeated hits, accessible Space activation, all 25 melody mappings, Hold while drumming, octave independence, mixer controls, OLED restoration, and responsive layouts. The normal instrument console was clear. Physical mobile multi-touch and subjective speaker/headphone sound quality still need a hands-on check.

## Design and course references

- [Final Figma frame](https://www.figma.com/design/KXUjSvnHLI06RCqXclXBwo/Synth?node-id=0-3)
- [Teacher course](https://github.com/ZakharDay/ADC-GID-26-27), especially the synth/effects patterns in tutorial 4
- [Teacher synth controls](https://zakharday.github.io/synth-controls/), including Sampler, Poly Synth, and Computer Keyboard examples
- [No-Bun boilerplate](https://github.com/ZakharDay/ADC-GID-Synth-No-Bun)

The project uses the teacher's `Tone.start()`, `PolySynth`, `Sampler` URLs/baseUrl/load callbacks, envelope settings, `connect`, Freeverb, and FeedbackDelay approaches. The requested sustained keydown/keyup interaction extends the teacher's short-note keyboard example. Reference repositories were read remotely and were not cloned into this project.

Third-party licenses are alongside the bundled Tone.js library and fonts in `assets/vendor/` and `assets/fonts/`. The SVGs in `assets/ui/` are unmodified exports from the approved Figma frame.

## Transport and performance (Phase 3)

Play loads Kick, Snare and Closed HH, then starts one looping `Tone.Sequence` of eight eighth notes: Kick on beats 1/3, Snare on beats 2/4, and Closed HH on every eighth (alternating velocities .55/.4). Repeated Play presses while loading or playing do nothing. Stop stops Transport, disposes the sequence, invalidates pending visual callbacks/loading hits, and releases drum tails and synth notes. Playing manually remains available with Transport stopped or running. Losing focus or hiding the page also stops playback to avoid unattended or stuck notes.

All pads are neutral at idle. Each manual or scheduled hit flashes the same blue state for 120 ms; keyboard focus has a separate outline. A held pad does not remain selected. Manual and sequenced hits share `playDrum()`, with `Tone.getDraw()` aligning sequenced visuals to audio time. Drum gain controls both manual and sequenced hits.

Phase 3 tests cover hit counts, duplicate Play prevention, transient pads, live synth/pads, BPM bounds/arrows, preserved Hold, Stop during loading, cancelled scheduled visuals, and restart. The browser audio fixture also renders the production groove at 120 and 180 BPM with real Tone.js, verifying timing and sound alongside synth and manual clap. It also checks a live tempo change, Stop, and neutral pad states with the real Transport. Teacher sequence reference: https://github.com/ZakharDay/synth-controls/blob/main/src/tone-examples/events/sequence.js.

## MIDI import (Phase 4)

Click **IMPORT** and choose a `.mid` or `.midi` file. Files are parsed locally, with the bundled 32 KB browser build of [@tonejs/midi 2.0.28](https://github.com/Tonejs/Midi). Its MIT license and the licenses of its bundled `midi-file` and `array-flatten` dependencies are in `assets/vendor/`. There is no runtime CDN request, installation, or build step.

`midi-import.js` contains parsing, track selection, import feedback, and MIDI scheduling. It accepts Standard MIDI formats 0/1 with quarter-note timing (PPQ), checks chunk boundaries, ignores empty and identified percussion tracks (channel 10 / zero-based 9 or percussion instrument), and selects the remaining track with the most valid notes. It stores note pitches, ticks, seconds, durations, velocity, PPQ, track name/channel, and tempo metadata. Drum-only files, SMPTE timing, format 2, malformed files, files over 5 MB, and selected tracks over 50,000 notes receive an OLED error. An invalid import keeps the previous melody. Successful imports stop playback and replace it; the last file read wins if reads overlap.

Play creates one non-looping `Tone.Part` of note-on/off events alongside the existing looping drum `Tone.Sequence`. Both start at transport position zero. Timing converts MIDI ticks to Transport ticks (rounding to the nearest tick, with a one-tick minimum duration). The initial MIDI tempo is applied; later tempo changes are intentionally ignored. Without tempo metadata, current BPM is retained. Imported tempos outside the normal 50–200 range expand the tempo input bounds to include that tempo. Editing BPM then scales MIDI note timing and the groove together. The melody plays once; drums continue until Stop.

MIDI uses the same PolySynth, filter, Synth level, effects, and Master as manual playing. A pitch shared by overlapping MIDI/manual notes sustains until all owners release it; overlapping identical pitches share one gate rather than retriggering separate voices. Manual Hold and octave changes do not alter or release imported pitches. MIDI key highlights use `Tone.getDraw()`, stay independent of manual highlights, and appear only within the currently displayed 25-key range. MIDI control changes (including sustain pedal), program changes, and track merging are not applied. Polyphony remains 32.

Play has neutral idle styling and becomes blue only when the observed Transport is running. Transport start/stop/pause events synchronize its state; Stop is a momentary button. Stop disposes both schedules, invalidates pending visual callbacks, releases notes, and resets position. Focus loss also stops playback. Settings and the imported file remain available for a clean restart.

Validation: `node tests/phase1.test.js` now also uses real binary MIDI fixtures and the bundled parser. [Browser MIDI checks](http://127.0.0.1:8000/tests/browser-midi.html) render actual MIDI plus drums and exercise live key highlights, octave independence, replacement, tempo, Stop/restart, manual performance, and errors. `node tests/create-midi-fixtures.js` regenerates the small deterministic files in `tests/fixtures/`. The regular browser audio checks continue to cover all eight samples and mixer/FX isolation.

## Manual latch state

Manual physical sources store their original musical pitch, whether the press belongs to latch mode, and whether it still owns an active note. `latchedNotes` stores pitches rather than computer key codes. A second press clears that pitch's latch and invalidates older held sources so their later keyup/pointerup cannot resurrect it. Latch toggling happens before asynchronous audio startup, so rapid initial taps settle to the final state. Pointer cancellation, focus loss, and Stop retain their safety cleanup. Enabling Hold also adopts currently pressed manual notes; disabling it releases every latch.

`soundingNotes` tracks manual audio ownership, separately from MIDI pitch counts and MIDI visual note IDs. MIDI note-off and manual unlatching release the shared synth gate only when the other source no longer owns that pitch. The piano combines active manual pitches, latched pitches, and MIDI visual sources, using the currently displayed pitch range. Octave changes update that view without changing existing source pitches. Voice B is intentionally independent of Hold: its manual and automatic hits always remain finite one-shots.

The interaction suite and browser MIDI fixture test chord construction and per-note toggling, repeat suppression, keyboard/pointer ownership, Hold OFF while a key is down, octave retention, audio-startup races, Stop/panic, MIDI overlap, pads with Hold ON, and four duplicate-free transport restarts. The real Tone.js offline test compares the imported MIDI plus drums with Hold ON/OFF and verifies identical audio and scheduled note endings.
