// PHASOR UI bindings (DESIGN.md §4.3). M0: exactly three controls —
// preset selector, clip-plane axis, clip-plane position. Yuki's rule: max
// three new controls per milestone, each visibly effective within 5 s.
import GUI from 'lil-gui';

/**
 * @param {string[]} presetNames
 * @param {{onPreset: (name: string) => void,
 *          onClip: (axis: 'x'|'y'|'z', frac: number) => void}} handlers
 */
export function buildUI(presetNames, handlers) {
  const state = { preset: presetNames[0], clipAxis: 'x', clipPosition: 1.0 };
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

  return state;
}
