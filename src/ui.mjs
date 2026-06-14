// PHASOR UI bindings (DESIGN.md §4.3). M0 controls: preset selector, clip
// axis, clip position. M1 added three (Yuki's rule): insulation thickness,
// slice z position, Solve. M2 adds the harmonic controls: field selector and
// frequency (the time scrubber itself lives in the bottom #scrub bar — the
// signature instrument). Readouts are display-only text, not controls.
import GUI from 'lil-gui';

// field-selector labels → internal mode ids consumed by SlicePanel
export const FIELD_MODES = {
  'T(t) instantaneous': 'instant',
  'Amplitude |T̂|': 'amplitude',
  'Phase lag τ': 'phase',
};

/**
 * @param {string[]} presetNames
 * @param {{onPreset: (name: string) => void,
 *          onClip: (axis: 'x'|'y'|'z', frac: number) => void,
 *          onInsulation: (thickness: number) => void,
 *          onSlice: (frac: number) => void,
 *          onField: (mode: 'instant'|'amplitude'|'phase') => void,
 *          onFreq: (f: 'annual'|'diurnal') => void,
 *          onSolve: () => void}} handlers
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
    solve: () => handlers.onSolve(),
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
  gui.add(state, 'insulation', 0.02, 0.30, 0.005)
    .name('Insulation [m]')
    .onChange((v) => handlers.onInsulation(v));
  gui.add(state, 'sliceZ', 0, 1, 0.01)
    .name('Slice z position')
    .onChange((v) => handlers.onSlice(v));
  gui.add(state, 'field', Object.keys(FIELD_MODES))
    .name('Field')
    .onChange((v) => handlers.onField(FIELD_MODES[v]));
  gui.add(state, 'freq', ['annual', 'diurnal'])
    .name('Frequency (amp/phase)')
    .onChange((v) => handlers.onFreq(v));
  gui.add(state, 'solve').name('Solve');

  return state;
}
