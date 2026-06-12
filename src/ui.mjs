// PHASOR UI bindings (DESIGN.md §4.3). M0 controls: preset selector, clip
// axis, clip position. M1 adds exactly three (Yuki's rule): insulation
// thickness, slice z position, Solve. Readouts are display-only text in the
// slices panel, not controls.
import GUI from 'lil-gui';

/**
 * @param {string[]} presetNames
 * @param {{onPreset: (name: string) => void,
 *          onClip: (axis: 'x'|'y'|'z', frac: number) => void,
 *          onInsulation: (thickness: number) => void,
 *          onSlice: (frac: number) => void,
 *          onSolve: () => void}} handlers
 */
export function buildUI(presetNames, handlers) {
  const state = {
    preset: presetNames[0],
    clipAxis: 'x',
    clipPosition: 1.0,
    insulation: 0.16,
    sliceZ: 0.5,
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
  gui.add(state, 'solve').name('Solve (ω = 0)');

  return state;
}
