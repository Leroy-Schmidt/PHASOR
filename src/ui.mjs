// PHASOR UI bindings (DESIGN.md §4.3). M0 controls: preset selector, clip
// axis, clip position. M1 added insulation thickness + slice z. M2 added the
// harmonic controls: field selector and frequency (the time scrubber lives in
// the bottom #scrub bar — the signature instrument). M4: auto re-solve (the
// Solve button is retired — geometry changes solve automatically on release),
// and controls that don't apply to the active preset are hidden so nothing
// reads as "broken". Readouts are display-only text, not controls.
import GUI from 'lil-gui';

// field-selector labels → internal mode ids consumed by SlicePanel
export const FIELD_MODES = {
  'T(t) instantaneous': 'instant',
  'Amplitude |T̂|': 'amplitude',
  'Phase lag τ': 'phase',
};

// Presets whose geometry responds to the Insulation [m] slider (they consume the
// `layers` build-up with an eps layer). The others ignore it — hide it for them.
const INSULATION_PRESETS = new Set(['wall1d', 'corner2d']);

/**
 * @param {string[]} presetNames
 * @param {{onPreset: (name: string) => void,
 *          onClip: (axis: 'x'|'y'|'z', frac: number) => void,
 *          onInsulation: (thickness: number) => void,
 *          onInsulationCommit: () => void,
 *          onSlice: (frac: number) => void,
 *          onField: (mode: 'instant'|'amplitude'|'phase') => void,
 *          onFreq: (f: 'annual'|'diurnal') => void,
 *          onFreqToggle: (f: 'annual'|'diurnal', on: boolean) => void}} handlers
 */
export function buildUI(presetNames, handlers) {
  const state = {
    preset: presetNames[0],
    clipAxis: 'x',
    clipPosition: 1.0,
    insulation: 0.16,
    sliceZ: 0.5,
    field: 'T(t) instantaneous',
    freq: 'annual',
    incAnnual: true,
    incDiurnal: true,
  };
  const gui = new GUI({ title: 'PHASOR' });

  gui.add(state, 'preset', presetNames)
    .name('Preset')
    .onChange((v) => handlers.onPreset(v));
  gui.add(state, 'clipAxis', ['x', 'y', 'z'])
    .name('Clip axis')
    .onChange(() => handlers.onClip(state.clipAxis, state.clipPosition));
  gui.add(state, 'clipPosition', 0, 1, 0.01)
    .name('Clip position')
    .onChange(() => handlers.onClip(state.clipAxis, state.clipPosition));
  // Insulation: drag repaints geometry live ("look before you solve"); the solve
  // fires once on release (onFinishChange) — Worker-discipline, no solve flood.
  const insulationCtrl = gui.add(state, 'insulation', 0.02, 0.30, 0.005)
    .name('Insulation [m]')
    .onChange((v) => handlers.onInsulation(v))
    .onFinishChange(() => handlers.onInsulationCommit());
  const sliceCtrl = gui.add(state, 'sliceZ', 0, 1, 0.01)
    .name('Slice z position')
    .onChange((v) => handlers.onSlice(v));
  gui.add(state, 'field', Object.keys(FIELD_MODES))
    .name('Field')
    .onChange((v) => handlers.onField(FIELD_MODES[v]));
  gui.add(state, 'freq', ['annual', 'diurnal'])
    .name('Frequency (amp/phase)')
    .onChange((v) => handlers.onFreq(v));
  // per-frequency toggles: which harmonics enter the instantaneous T(t) sum
  gui.add(state, 'incAnnual')
    .name('T(t): annual')
    .onChange((v) => handlers.onFreqToggle('annual', v));
  gui.add(state, 'incDiurnal')
    .name('T(t): diurnal')
    .onChange((v) => handlers.onFreqToggle('diurnal', v));

  // Hide controls that do nothing on the active preset (handoff polish): the
  // insulation slider only bites presets with an eps build-up; the slice-z
  // control only matters when the geometry actually varies along z. Every
  // current preset is a z-uniform extrusion (2D physics), so slice-z is a no-op
  // and stays hidden — it re-appears automatically for a true 3D preset.
  state.refreshControls = (presetName, zVaries) => {
    insulationCtrl.show(INSULATION_PRESETS.has(presetName));
    sliceCtrl.show(!!zVaries);
  };

  return state;
}
