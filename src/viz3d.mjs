// PHASOR 3D geometry view (DESIGN.md §4.1 decision 5): three.js scene showing
// material voxels with a movable clip plane. Gains in-scene slice planes in M4.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { cellIndex } from './grid.mjs';
import { symmetryTransforms, mirroredExtent } from './symmetry.mjs';
import { planeAxes, nearestLayers, sampleField } from './slice.mjs';
import { fluxGlyphs } from './flux.mjs';

const AXIS_N = { x: 0, y: 1, z: 2 };

export class Viz3D {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.container = container;
    // preserveDrawingBuffer: canvas stays readable after render (PNG export, M4)
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.localClippingEnabled = true;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14161a);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(3, 5, 4);
    this.scene.add(sun);

    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e6);
    this.groups = [];  // voxel groups: [base, ...symmetry mirrors] (one per reflection)
    this.extent = null;
    // quarter-symmetry mirror (M5 full-cellar view): the reflection transforms
    // applied to the solved quadrant for DISPLAY. null/[] → no mirror (one copy).
    this.symmetryAxes = null;
    this.mirrorTransforms = [{ scale: [1, 1, 1], offset: [0, 0, 0] }];

    // The cutting plane (view rework): one plane that BOTH clips the geometry and
    // carries the field (colormap + arrows) on the exposed cut face. `cutAxis` is
    // its normal (x/y/z), `cutFrac` its position along that axis (0..1 of extent;
    // 1 ⇒ no clip). Default z, matching the 2D XY field panel.
    this.cutAxis = 'z';
    this.cutFrac = 0.5;
    this.arrows = true;            // draw flux arrows on the cut (flux mode)
    this._model = null;            // { grid, painted, materials } for re-sampling
    this._fieldData = null;        // last emitted { kind, field, range, cm, fluxQ }
    this.field = null;             // { mesh, texture, data, texW, texH, key, mirrors, arrowGroup }

    // render on demand: redraw only on camera moves, resizes, model changes
    this.render = () => this.renderer.render(this.scene, this.camera);
    this.controls.addEventListener('change', this.render);

    this._sized = false;
    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      this._sized = true;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.render();
    };
    this.resize = resize;
    // ResizeObserver alone is fragile: if the viewport is first laid out at 0×0
    // (tab restored, DevTools toggled, tiling WM) its callback can be missed and
    // the canvas stays at the three.js default — a black viewport. Back it with
    // a window-resize listener and a short rAF kick until the first real size.
    new ResizeObserver(resize).observe(container);
    window.addEventListener('resize', resize);
    let kicks = 120;
    const kick = () => {
      resize();
      if (!this._sized && kicks-- > 0) requestAnimationFrame(kick);
    };
    kick();
  }

  /**
   * Rebuild the voxel view: one InstancedMesh per material (background skipped).
   * @param {object} grid — from buildGrid
   * @param {{cells: Uint16Array, matIds: string[]}} painted
   * @param {object} materials — MATERIALS table (id → {color, ...})
   * @param {string} backgroundId
   * @param {{x:number[], y:number[], z:number[]}} extent
   */
  showModel(grid, painted, materials, backgroundId, extent) {
    this._disposeGroups();
    this._disposeField(); // a new model invalidates the old field plane
    this.extent = extent;

    // reflection transforms: identity + symmetry mirrors (display-only). Stored
    // so setFieldSlice mirrors the field plane the same way.
    this.mirrorTransforms = (this.symmetryAxes && this.symmetryAxes.length)
      ? symmetryTransforms(this.symmetryAxes, extent)
      : [{ scale: [1, 1, 1], offset: [0, 0, 0] }];

    for (const tr of this.mirrorTransforms) {
      const group = this._makeVoxelGroup(grid, painted, materials, backgroundId);
      // reflection (scale ±1, offset 2·plane) maps the quadrant onto its mirror;
      // identity transform leaves the solved quadrant in place.
      group.matrixAutoUpdate = false;
      group.matrix.makeScale(...tr.scale).setPosition(...tr.offset);
      this.scene.add(group);
      this.groups.push(group);
    }

    // frame the WHOLE mirrored model so the full cellar is in view
    const view = (this.symmetryAxes && this.symmetryAxes.length)
      ? mirroredExtent(this.symmetryAxes, extent) : extent;
    this.frame(view);
    // resize() renders at the correct size; if the container isn't sized yet
    // the constructor's rAF kick will render this model once it is.
    this.resize();
  }

  /** Build one Group of per-material InstancedMeshes (the solved quadrant). */
  _makeVoxelGroup(grid, painted, materials, backgroundId) {
    const group = new THREE.Group();
    const counts = new Array(painted.matIds.length).fill(0);
    for (let c = 0; c < painted.cells.length; c++) counts[painted.cells[c]]++;

    const matrix = new THREE.Matrix4();
    for (let m = 0; m < painted.matIds.length; m++) {
      const id = painted.matIds[m];
      if (id === backgroundId || counts[m] === 0) continue;
      const color = materials[id]?.color ?? 0xff00ff;
      const mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshLambertMaterial({
          color,
          side: THREE.DoubleSide, // cut cells read as little open boxes — shows grading
          clippingPlanes: [this.clipPlane],
        }),
        counts[m],
      );
      let n = 0;
      for (let k = 0; k < grid.nz; k++) {
        for (let j = 0; j < grid.ny; j++) {
          for (let i = 0; i < grid.nx; i++) {
            if (painted.cells[cellIndex(grid, i, j, k)] !== m) continue;
            matrix.makeScale(grid.dx[i], grid.dy[j], grid.dz[k]);
            matrix.setPosition(
              (grid.xs[i] + grid.xs[i + 1]) / 2,
              (grid.ys[j] + grid.ys[j + 1]) / 2,
              (grid.zs[k] + grid.zs[k + 1]) / 2,
            );
            mesh.setMatrixAt(n++, matrix);
          }
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
    }
    return group;
  }

  _disposeGroups() {
    for (const g of this.groups) {
      g.traverse((o) => {
        if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
      });
      this.scene.remove(g);
    }
    this.groups = [];
  }

  /**
   * Declare the symmetry axes of the next-loaded preset (e.g. ['x','z']). When
   * set, showModel renders the solved quadrant mirrored out to the full model
   * (display only — no re-solve). Pass null/[] to show the bare quadrant.
   */
  setSymmetry(axes) { this.symmetryAxes = axes && axes.length ? axes : null; }

  /** Aim the camera at the model bounds (only on preset change). */
  frame(extent) {
    const cx = (extent.x[0] + extent.x[1]) / 2;
    const cy = (extent.y[0] + extent.y[1]) / 2;
    const cz = (extent.z[0] + extent.z[1]) / 2;
    const span = Math.max(
      extent.x[1] - extent.x[0],
      extent.y[1] - extent.y[0],
      extent.z[1] - extent.z[0],
    );
    this.controls.target.set(cx, cy, cz);
    this.camera.position.set(cx + 1.4 * span, cy + 1.1 * span, cz + 1.6 * span);
    this.camera.near = span / 100;
    this.camera.far = span * 50;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /**
   * Store the displayed field and render it on the cutting plane. The payload is
   * the 2D panel's field, decoupled from any plane: full-grid arrays the cut
   * samples on whatever axis it faces.
   * @param {{grid, painted, materials: object}} model
   * @param {null | {kind: 'nodal'|'cell', field: Float64Array,
   *   range: [number, number], cm: Function, fluxQ: object|null}} payload
   */
  setField(model, payload) {
    this._model = model;
    this._fieldData = payload;
    if (!payload || !payload.field || !payload.range) { this.clearFieldSlice(); return; }
    this._rebuildField();
    this.render();
  }

  /** Toggle the flux arrows on the cut (flux mode only). */
  setArrows(on) { this.arrows = !!on; this._rebuildField(); this.render(); }

  /**
   * Move the single cutting plane: it BOTH clips the geometry (far side removed)
   * and carries the field on the exposed cut face — one plane, no separate clip.
   * @param {'x'|'y'|'z'} axis — plane normal
   * @param {number} frac — 0..1 of the extent; 1 ⇒ no clip (whole object)
   */
  setCut(axis, frac) {
    this.cutAxis = axis;
    this.cutFrac = frac;
    if (this.extent) {
      const [lo, hi] = this.extent[axis];
      const pos = lo + frac * (hi - lo);
      const n = { x: [-1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] }[axis];
      this.clipPlane.normal.set(...n); // keep coordinate <= pos (far side clipped)
      this.clipPlane.constant = frac >= 1 ? 1e6 : pos;
    }
    this._rebuildField();
    this.render();
  }

  /** World position of the cut along its normal axis. */
  _cutCoord() {
    const [lo, hi] = this.extent[this.cutAxis];
    return lo + this.cutFrac * (hi - lo);
  }

  /** Right-handed basis (Matrix4) orienting the textured quad: local X→in-plane
   *  axis a, local Y→axis b, local Z→plane normal. a,b match slice.planeAxes. */
  _planeBasis(axis) {
    const X = new THREE.Vector3(1, 0, 0);
    const Y = new THREE.Vector3(0, 1, 0);
    const Z = new THREE.Vector3(0, 0, 1);
    const m = new THREE.Matrix4();
    if (axis === 'z') m.makeBasis(X, Y, Z);            // a=x, b=y, n=+z
    else if (axis === 'x') m.makeBasis(Y, Z, X);        // a=y, b=z, n=+x
    else m.makeBasis(X, Z, Y.clone().negate());         // a=x, b=z, n=−y (right-handed)
    return m;
  }

  /** (Re)build the cut-plane texture + arrows from the stored field at the cut. */
  _rebuildField() {
    if (!this._model || !this._fieldData || !this._fieldData.field) return;
    const { grid, painted, materials } = this._model;
    const { kind, field, range, cm, fluxQ } = this._fieldData;
    const axis = this.cutAxis;
    const axisN = AXIS_N[axis];
    const [pa, pb] = planeAxes(axis);
    const COORD = [grid.xs, grid.ys, grid.zs];
    const NC = [grid.nx, grid.ny, grid.nz];
    const aMin = COORD[pa][0];
    const bMin = COORD[pb][0];
    const spanA = COORD[pa][NC[pa]] - aMin;
    const spanB = COORD[pb][NC[pb]] - bMin;
    const coord = this._cutCoord();

    // texel grid: square-ish, capped so a scrub tick stays cheap (G4.1)
    const MAX = 256;
    const aspect = spanA / spanB;
    const texW = Math.max(8, Math.round(aspect >= 1 ? MAX : MAX * aspect));
    const texH = Math.max(8, Math.round(aspect >= 1 ? MAX / aspect : MAX));
    const key = `${axis}:${grid.nx}x${grid.ny}x${grid.nz}:${texW}x${texH}`;

    if (!this.field || this.field.key !== key) {
      this._disposeField();
      const data = new Uint8Array(texW * texH * 4);
      const texture = new THREE.DataTexture(data, texW, texH, THREE.RGBAFormat);
      texture.flipY = false;        // row 0 = b minimum ↔ plane local-Y = 0
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      const geom = new THREE.PlaneGeometry(spanA, spanB);
      const mat = new THREE.MeshBasicMaterial({
        map: texture, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide,
        depthTest: true, // embedded in the cut — occluded by geometry on the kept side
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 10;
      this.scene.add(mesh);
      this.field = { mesh, texture, data, texW, texH, key, mirrors: null, arrowGroup: null };
    }

    // orient + position the quad at the cut
    const pos = new THREE.Vector3();
    pos.setComponent(pa, aMin + spanA / 2);
    pos.setComponent(pb, bMin + spanB / 2);
    pos.setComponent(axisN, coord);
    const baseMatrix = this._planeBasis(axis).setPosition(pos);
    this.field.mesh.matrix.copy(baseMatrix);
    this.field.baseMatrix = baseMatrix;

    // fill the texture from the sampled plane + colormap
    const vals = sampleField({ kind, field, grid, painted, materials, axis, coord, resA: texW, resB: texH });
    const { data } = this.field;
    const [lo, hi] = range;
    const inv = hi > lo ? 1 / (hi - lo) : 0;
    for (let i = 0; i < vals.length; i++) {
      const o = 4 * i;
      const v = vals[i];
      if (!Number.isFinite(v)) { data[o + 3] = 0; continue; } // void / masked → transparent
      const [cr, cg, cb] = cm((v - lo) * inv);
      data[o] = cr; data[o + 1] = cg; data[o + 2] = cb; data[o + 3] = 255;
    }
    this.field.texture.needsUpdate = true;

    this._rebuildArrows(grid, fluxQ, kind, range, axis, pa, pb, axisN, coord, NC, COORD);
    this._updateFieldMirrors();
  }

  /** Flux arrows on the cut: in-plane line segments built from `fluxGlyphs(axis)`. */
  _rebuildArrows(grid, fluxQ, kind, range, axis, pa, pb, axisN, coord, NC, COORD) {
    if (this.field.arrowGroup) { this.scene.remove(this.field.arrowGroup); this._disposeArrowGroup(); }
    if (!(this.arrows && kind === 'cell' && fluxQ)) { this.field.arrowGroup = null; return; }

    const { kCell } = nearestLayers(grid, axis, coord);
    const stride = Math.max(1, Math.round(Math.max(NC[pa], NC[pb]) / 14));
    const sc = range[1] > 0 ? range[1] : undefined;
    const { glyphs } = fluxGlyphs(fluxQ, grid, kCell, { axis, stride, scale: sc });
    if (!glyphs.length) { this.field.arrowGroup = null; return; }
    const MIN_LEN = 0.07; // skip near-zero-flux cells so arrows aren't dot-noise

    const meanCell = Math.min(
      (COORD[pa][NC[pa]] - COORD[pa][0]) / NC[pa],
      (COORD[pb][NC[pb]] - COORD[pb][0]) / NC[pb],
    );
    const L = 0.45 * stride * meanCell; // longest arrow, metres
    const verts = [];
    const set = (arr, a, b) => { // push a point with in-plane (a,b) at the cut depth
      const p = [0, 0, 0]; p[pa] = a; p[pb] = b; p[axisN] = coord; arr.push(p[0], p[1], p[2]);
    };
    for (const g of glyphs) {
      if (g.len < MIN_LEN) continue;
      const l = g.len * L;
      const ha = g.a + g.ua * l / 2; const hb = g.b + g.ub * l / 2; // head
      const ta = g.a - g.ua * l / 2; const tb = g.b - g.ub * l / 2; // tail
      set(verts, ta, tb); set(verts, ha, hb);
      // two arrowhead barbs (rotate −dir by ±0.5 rad in-plane)
      const hl = 0.4 * l;
      for (const s of [0.5, -0.5]) {
        const c = Math.cos(s); const sn = Math.sin(s);
        const ba = -(g.ua * c - g.ub * sn); const bb = -(g.ua * sn + g.ub * c);
        set(verts, ha, hb); set(verts, ha + ba * hl, hb + bb * hl);
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xf4f6fa, transparent: true, opacity: 0.92, depthTest: true });
    const lines = new THREE.LineSegments(geom, mat);
    lines.renderOrder = 11;
    const group = new THREE.Group();
    group.add(lines);
    this.scene.add(group);
    this.field.arrowGroup = group;
  }

  /**
   * Mirror the cut plane (and arrows) onto the symmetry copies for the full-model
   * view. Each clone's transform is the reflection R composed with the base
   * plane transform, so the field + arrows land on the correct mirrored slice.
   */
  _updateFieldMirrors() {
    if (!this.field) return;
    const mirrors = this.mirrorTransforms.slice(1); // [0] = identity (the base)
    if (this.field.mirrors) for (const c of this.field.mirrors) this.scene.remove(c);
    const R = new THREE.Matrix4();
    this.field.mirrors = mirrors.map((mt) => {
      const grp = new THREE.Group();
      grp.matrixAutoUpdate = false;
      R.makeScale(...mt.scale).setPosition(...mt.offset);
      // plane clone (shares geometry + material + texture → one refill paints all)
      const planeClone = this.field.mesh.clone();
      planeClone.matrixAutoUpdate = false;
      planeClone.matrix.copy(this.field.baseMatrix);
      grp.add(planeClone);
      if (this.field.arrowGroup) grp.add(this.field.arrowGroup.children[0].clone());
      grp.matrix.copy(R);
      this.scene.add(grp);
      return grp;
    });
  }

  /** Remove the in-scene cut plane (e.g. on geometry change before a re-solve). */
  clearFieldSlice() {
    this._disposeField();
    this.render();
  }

  _disposeArrowGroup() {
    if (!this.field || !this.field.arrowGroup) return;
    this.field.arrowGroup.traverse((o) => {
      if (o.isLine) { o.geometry.dispose(); o.material.dispose(); }
    });
  }

  _disposeField() {
    if (!this.field) return;
    if (this.field.mirrors) for (const c of this.field.mirrors) this.scene.remove(c);
    if (this.field.arrowGroup) { this.scene.remove(this.field.arrowGroup); this._disposeArrowGroup(); }
    this.scene.remove(this.field.mesh);
    this.field.mesh.geometry.dispose();
    this.field.mesh.material.dispose();
    this.field.texture.dispose();
    this.field = null;
  }
}
