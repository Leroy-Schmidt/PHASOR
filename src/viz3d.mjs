// PHASOR 3D geometry view (DESIGN.md §4.1 decision 5): three.js scene showing
// material voxels with a movable clip plane. Gains in-scene slice planes in M4.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { cellIndex } from './grid.mjs';

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
