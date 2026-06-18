// PHASOR 3D geometry view (DESIGN.md §4.1 decision 5): three.js scene showing
// material voxels with a movable clip plane. Gains in-scene slice planes in M4.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { cellIndex, nodeIndex } from './grid.mjs';

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

    this.clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1e6);
    this.group = null;
    this.extent = null;
    this.field = null; // in-scene field slice plane (M4): { mesh, texture, data, key }

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
    if (this.group) {
      this.group.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose();
          o.material.dispose();
        }
      });
      this.scene.remove(this.group);
    }
    this._disposeField(); // a new model invalidates the old field plane
    this.group = new THREE.Group();
    this.extent = extent;

    // count cells per material index
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
      this.group.add(mesh);
    }
    this.scene.add(this.group);
    this.frame(extent);
    // resize() renders at the correct size; if the container isn't sized yet
    // the constructor's rAF kick will render this model once it is.
    this.resize();
  }

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
   * Paint a temperature/amplitude/phase field ONTO the model as an in-scene slice
   * plane (DESIGN §6 — the M4 headline). The plane mirrors the 2D SlicePanel's
   * field exactly (same values, range, colormap), so the field breathes on the 3D
   * model as the scrubber sweeps — no second physics path, no re-solve.
   *
   * Geometry (an XY quad at the slice z) is rebuilt only when the model or slice
   * position changes; the per-scrub-tick call just refills the texture, which is
   * cheap enough for ≥ 30 fps (G4.1).
   *
   * @param {{grid: object, painted: object, materials: object}} model
   * @param {Float64Array} T nodal field for this model's grid
   * @param {[number, number]} range [lo, hi] used by the colormap (panel's range)
   * @param {(t: number) => [number, number, number]} cm colormap (colormap.mjs)
   * @param {number} fracZ slice position along z, 0..1 of the z extent
   */
  setFieldSlice(model, T, range, cm, fracZ) {
    if (!T || !range) { this.clearFieldSlice(); return; }
    const { grid, painted, materials } = model;
    const { xs, ys, zs, nx, ny, nz } = grid;
    const xmin = xs[0];
    const ymin = ys[0];
    const spanX = xs[nx] - xmin;
    const spanY = ys[ny] - ymin;

    // nearest node plane (field) and the cell layer it reads materials from
    const zCoord = zs[0] + fracZ * (zs[nz] - zs[0]);
    let kNode = 0;
    for (let k = 1; k <= nz; k++) {
      if (Math.abs(zs[k] - zCoord) < Math.abs(zs[kNode] - zCoord)) kNode = k;
    }
    const kCell = Math.min(kNode, nz - 1);

    // texture resolution: square-ish texels, capped so a scrub tick stays cheap
    const MAX = 256;
    const aspect = spanX / spanY;
    const texW = Math.max(8, Math.round(aspect >= 1 ? MAX : MAX * aspect));
    const texH = Math.max(8, Math.round(aspect >= 1 ? MAX / aspect : MAX));
    const key = `${nx}x${ny}x${nz}@${kNode}:${texW}x${texH}:${spanX},${spanY}`;

    if (!this.field || this.field.key !== key) {
      this._disposeField();
      const data = new Uint8Array(texW * texH * 4);
      const texture = new THREE.DataTexture(data, texW, texH, THREE.RGBAFormat);
      texture.flipY = false;        // row 0 = bottom (y = ymin) ↔ plane v = 0
      texture.colorSpace = THREE.SRGBColorSpace; // colormap bytes are display sRGB
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      const geom = new THREE.PlaneGeometry(spanX, spanY);
      const mat = new THREE.MeshBasicMaterial({
        map: texture, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide,
        depthTest: false, // overlay the field on the model from any orbit angle
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(xmin + spanX / 2, ymin + spanY / 2, zCoord);
      mesh.renderOrder = 10; // drawn after the voxels
      this.scene.add(mesh);
      this.field = { mesh, texture, data, texW, texH, key };
    } else {
      this.field.mesh.position.z = zCoord;
    }

    // per-texel: void → transparent; solid → bilinear field sample + colormap
    const { data, texW: tw, texH: th } = this.field;
    const [lo, hi] = range;
    const inv = hi > lo ? 1 / (hi - lo) : 0;
    const colCell = new Int32Array(tw);
    for (let c = 0, i = 0; c < tw; c++) {
      const x = xmin + ((c + 0.5) / tw) * spanX;
      while (i < nx - 1 && x > xs[i + 1]) i++;
      while (i > 0 && x < xs[i]) i--;
      colCell[c] = i;
    }
    for (let r = 0; r < th; r++) {
      const y = ymin + ((r + 0.5) / th) * spanY;
      let j = 0;
      while (j < ny - 1 && y > ys[j + 1]) j++;
      const ty = (y - ys[j]) / (ys[j + 1] - ys[j]);
      for (let c = 0; c < tw; c++) {
        const i = colCell[c];
        const o = 4 * (r * tw + c);
        if (!materials[painted.matIds[painted.cells[cellIndex(grid, i, j, kCell)]]]) {
          data[o + 3] = 0; // void — transparent
          continue;
        }
        const x = xmin + ((c + 0.5) / tw) * spanX;
        const tx = (x - xs[i]) / (xs[i + 1] - xs[i]);
        const v00 = T[nodeIndex(grid, i, j, kNode)];
        const v10 = T[nodeIndex(grid, i + 1, j, kNode)];
        const v01 = T[nodeIndex(grid, i, j + 1, kNode)];
        const v11 = T[nodeIndex(grid, i + 1, j + 1, kNode)];
        const v = (1 - ty) * ((1 - tx) * v00 + tx * v10) + ty * ((1 - tx) * v01 + tx * v11);
        if (!Number.isFinite(v)) { data[o + 3] = 0; continue; } // masked → voxel shows through
        const [cr, cg, cb] = cm((v - lo) * inv);
        data[o] = cr; data[o + 1] = cg; data[o + 2] = cb; data[o + 3] = 255;
      }
    }
    this.field.texture.needsUpdate = true;
    this.render();
  }

  /** Remove the in-scene field plane (e.g. on geometry change before a re-solve). */
  clearFieldSlice() {
    this._disposeField();
    this.render();
  }

  _disposeField() {
    if (!this.field) return;
    this.scene.remove(this.field.mesh);
    this.field.mesh.geometry.dispose();
    this.field.mesh.material.dispose();
    this.field.texture.dispose();
    this.field = null;
  }

  /**
   * Clip away everything beyond `frac` of the domain along `axis`.
   * @param {'x'|'y'|'z'} axis
   * @param {number} frac — 0..1 of the domain extent; 1 shows everything
   */
  setClip(axis, frac) {
    const [lo, hi] = this.extent[axis];
    const pos = lo + frac * (hi - lo);
    const n = { x: [-1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] }[axis];
    this.clipPlane.normal.set(...n);
    // keep points with normal·p + constant >= 0, i.e. coordinate <= pos
    this.clipPlane.constant = frac >= 1 ? 1e6 : pos;
    this.render();
  }
}
