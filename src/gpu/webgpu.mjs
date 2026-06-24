// PHASOR WebGPU steady solver (S2-M2.2). A GPU-resident, fp32, Jacobi-preconditioned
// CG for the real SPD steady system, mirroring the CPU `cg` (src/solver.mjs) but
// running the whole loop on the GPU: SpMV + axpy + dot + the alpha/beta scalar
// updates are all kernels, vectors stay in GPU buffers, and only the residual is
// read back (every CHECK_EVERY iters). The operator is the explicit CSR from
// `assembleCSR` (src/fem.mjs), gated against `applyA` in node (S2-G2.B).
//
// This module is BROWSER/Worker-only (needs `navigator.gpu`); it is never imported
// by the node-tested core. fp32 floor is ~1e-5 (Phase-0 probe) — ~5 sig figs, past
// the 3-4 that matter physically. The fp64 CPU `cg` remains the certified reference
// + fallback (worker.mjs feature-detect).
//
// Each kernel is its own single-entry module with minimal contiguous bindings, so
// `layout:'auto'` infers exactly the bindings the bind groups provide.
import { assembleCSR } from '../fem.mjs';

const WG = 256;            // workgroup size
const HALF = WG / 2;
const CHECK_EVERY = 10;    // iters between residual readbacks

let _devicePromise = null;
/** Cached GPUDevice, or null if WebGPU is unavailable / device request fails. */
export async function getDevice() {
  if (_devicePromise) return _devicePromise;
  _devicePromise = (async () => {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      return await adapter.requestDevice();
    } catch { return null; }
  })();
  return _devicePromise;
}

// ----------------------------------------------------------------- WGSL kernels
// y = A x  (CSR; one row per invocation, columns summed in stored order)
const K_SPMV = /* wgsl */`
@group(0) @binding(0) var<storage, read>       rowPtr : array<u32>;
@group(0) @binding(1) var<storage, read>       colIdx : array<u32>;
@group(0) @binding(2) var<storage, read>       vals   : array<f32>;
@group(0) @binding(3) var<storage, read>       srcX   : array<f32>;
@group(0) @binding(4) var<storage, read_write> dstY   : array<f32>;
@group(0) @binding(5) var<uniform>             N      : u32;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let r = gid.x; if (r >= N) { return; }
  var s : f32 = 0.0;
  let e = rowPtr[r + 1u];
  for (var p = rowPtr[r]; p < e; p = p + 1u) { s = s + vals[p] * srcX[colIdx[p]]; }
  dstY[r] = s;
}`;

// elementwise kernels: A is read_write, B/C read, scalar s read (length-1)
const elem = (body) => /* wgsl */`
@group(0) @binding(0) var<storage, read_write> A : array<f32>;
@group(0) @binding(1) var<storage, read>       B : array<f32>;
@group(0) @binding(2) var<storage, read>       C : array<f32>;
@group(0) @binding(3) var<uniform>             N : u32;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) g : vec3<u32>) { let i = g.x; if (i >= N) { return; } ${body} }`;
const K_SUB = elem('A[i] = B[i] - C[i];');   // r = b - Ap
const K_MUL = elem('A[i] = B[i] * C[i];');   // z = r .* diagInv

const saxpy = (body) => /* wgsl */`
@group(0) @binding(0) var<storage, read_write> A : array<f32>;
@group(0) @binding(1) var<storage, read>       B : array<f32>;
@group(0) @binding(2) var<storage, read>       s : array<f32>;
@group(0) @binding(3) var<uniform>             N : u32;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) g : vec3<u32>) { let i = g.x; if (i >= N) { return; } ${body} }`;
const K_AXPY = saxpy('A[i] = A[i] + s[0] * B[i];'); // x += alpha p
const K_AXMY = saxpy('A[i] = A[i] - s[0] * B[i];'); // r -= alpha Ap
const K_XPBY = saxpy('A[i] = B[i] + s[0] * A[i];'); // p = z + beta p

const K_DOT = /* wgsl */`
@group(0) @binding(0) var<storage, read>       a : array<f32>;
@group(0) @binding(1) var<storage, read>       b : array<f32>;
@group(0) @binding(2) var<storage, read_write> partials : array<f32>;
@group(0) @binding(3) var<uniform>             N : u32;
var<workgroup> sdata : array<f32, ${WG}>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(local_invocation_id)  lid : vec3<u32>,
        @builtin(workgroup_id)         wid : vec3<u32>) {
  let i = gid.x;
  var v : f32 = 0.0; if (i < N) { v = a[i] * b[i]; }
  sdata[lid.x] = v; workgroupBarrier();
  var stride : u32 = ${HALF}u;
  loop {
    if (stride == 0u) { break; }
    if (lid.x < stride) { sdata[lid.x] = sdata[lid.x] + sdata[lid.x + stride]; }
    workgroupBarrier(); stride = stride / 2u;
  }
  if (lid.x == 0u) { partials[wid.x] = sdata[0]; }
}`;

const K_REDUCE = /* wgsl */`
@group(0) @binding(0) var<storage, read>       partials : array<f32>;
@group(0) @binding(1) var<storage, read_write> outv : array<f32>;
@group(0) @binding(2) var<uniform>             M : u32;
var<workgroup> sdata : array<f32, ${WG}>;
@compute @workgroup_size(${WG})
fn main(@builtin(local_invocation_id) lid : vec3<u32>) {
  var v : f32 = 0.0; var i : u32 = lid.x;
  loop { if (i >= M) { break; } v = v + partials[i]; i = i + ${WG}u; }
  sdata[lid.x] = v; workgroupBarrier();
  var stride : u32 = ${HALF}u;
  loop {
    if (stride == 0u) { break; }
    if (lid.x < stride) { sdata[lid.x] = sdata[lid.x] + sdata[lid.x + stride]; }
    workgroupBarrier(); stride = stride / 2u;
  }
  if (lid.x == 0u) { outv[0] = sdata[0]; }
}`;

// alpha = rz / pap
const K_ALPHA = /* wgsl */`
@group(0) @binding(0) var<storage, read>       rz    : array<f32>;
@group(0) @binding(1) var<storage, read>       pap   : array<f32>;
@group(0) @binding(2) var<storage, read_write> alpha : array<f32>;
@compute @workgroup_size(1)
fn main() { let d = pap[0]; alpha[0] = select(0.0, rz[0] / d, d != 0.0); }`;
// beta = rzNew / rz ; then rz <- rzNew
const K_BETA = /* wgsl */`
@group(0) @binding(0) var<storage, read_write> rz    : array<f32>;
@group(0) @binding(1) var<storage, read>       rzNew : array<f32>;
@group(0) @binding(2) var<storage, read_write> beta  : array<f32>;
@compute @workgroup_size(1)
fn main() { let old = rz[0]; let rn = rzNew[0]; beta[0] = select(0.0, rn / old, old != 0.0); rz[0] = rn; }`;

// ----------------------------------------------------------------- helpers
const STORAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
const UNIFORM = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
function buf(device, bytes, usage) { return device.createBuffer({ size: Math.max(bytes, 4), usage }); }
function u32buf(device, value) {
  const b = buf(device, 16, UNIFORM);
  device.queue.writeBuffer(b, 0, new Uint32Array([value, 0, 0, 0]));
  return b;
}

/**
 * GPU-resident fp32 Jacobi-CG for the steady real system. Returns the solution
 * as a Float64Array (fp32-accurate, ~1e-5), matching the shape of cg().x.
 *
 * @param {object} problem — from assemble() (carries diag, b, x0, nNodes)
 * @param {{tol?: number, maxIter?: number}} [opts]
 * @returns {Promise<{x: Float64Array, iterations: number, relRes: number, converged: boolean}>}
 */
export async function gpuSolveSteady(problem, { tol = 1e-5, maxIter = 4000 } = {}) {
  const device = await getDevice();
  if (!device) throw new Error('WebGPU unavailable');

  const csr = assembleCSR(problem);
  const n = csr.n;
  const nnz = csr.vals.length;
  const numWG = Math.ceil(n / WG);
  const vWG = Math.ceil(n / WG);

  const diagInvF = new Float32Array(n);
  for (let i = 0; i < n; i++) diagInvF[i] = 1 / problem.diag[i];

  const F = (len) => buf(device, len * 4, STORAGE);
  const gRowPtr = F(n + 1); device.queue.writeBuffer(gRowPtr, 0, csr.rowPtr);
  const gColIdx = F(nnz); device.queue.writeBuffer(gColIdx, 0, csr.colIdx);
  const gVals = F(nnz); device.queue.writeBuffer(gVals, 0, Float32Array.from(csr.vals));
  const gB = F(n); device.queue.writeBuffer(gB, 0, Float32Array.from(problem.b));
  const gDiagInv = F(n); device.queue.writeBuffer(gDiagInv, 0, diagInvF);
  const gX = F(n); device.queue.writeBuffer(gX, 0, Float32Array.from(problem.x0));
  const gR = F(n), gZ = F(n), gP = F(n), gAp = F(n), gPart = F(numWG);
  const sRz = F(1), sPap = F(1), sRzNew = F(1), sRr = F(1), sAlpha = F(1), sBeta = F(1), sBnorm = F(1);
  const uN = u32buf(device, n);
  const uNumWG = u32buf(device, numWG);

  const pipe = (code) => device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  const pSpmv = pipe(K_SPMV), pSub = pipe(K_SUB), pMul = pipe(K_MUL),
    pAxpy = pipe(K_AXPY), pAxmy = pipe(K_AXMY), pXpby = pipe(K_XPBY),
    pDot = pipe(K_DOT), pRed = pipe(K_REDUCE), pAlpha = pipe(K_ALPHA), pBeta = pipe(K_BETA);

  const bg = (pipeline, bufs) => device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: bufs.map((b, i) => ({ binding: i, resource: { buffer: b } })),
  });
  const bgSpmvX = bg(pSpmv, [gRowPtr, gColIdx, gVals, gX, gAp, uN]);
  const bgSpmvP = bg(pSpmv, [gRowPtr, gColIdx, gVals, gP, gAp, uN]);
  const bgSubR = bg(pSub, [gR, gB, gAp, uN]);          // r = b - Ap
  const bgMulZ = bg(pMul, [gZ, gR, gDiagInv, uN]);     // z = r .* diagInv
  const bgAxpyX = bg(pAxpy, [gX, gP, sAlpha, uN]);     // x += alpha p
  const bgAxmyR = bg(pAxmy, [gR, gAp, sAlpha, uN]);    // r -= alpha Ap
  const bgXpbyP = bg(pXpby, [gP, gZ, sBeta, uN]);      // p = z + beta p
  const bgDotRZ = bg(pDot, [gR, gZ, gPart, uN]);
  const bgDotPAp = bg(pDot, [gP, gAp, gPart, uN]);
  const bgDotRR = bg(pDot, [gR, gR, gPart, uN]);
  const bgDotBB = bg(pDot, [gB, gB, gPart, uN]);
  const bgRedRZ = bg(pRed, [gPart, sRz, uNumWG]);
  const bgRedPAp = bg(pRed, [gPart, sPap, uNumWG]);
  const bgRedRZNew = bg(pRed, [gPart, sRzNew, uNumWG]);
  const bgRedRR = bg(pRed, [gPart, sRr, uNumWG]);
  const bgRedBB = bg(pRed, [gPart, sBnorm, uNumWG]);
  const bgAlpha = bg(pAlpha, [sRz, sPap, sAlpha]);
  const bgBeta = bg(pBeta, [sRz, sRzNew, sBeta]);

  const vec = (pass, pipeline, group) => { pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(vWG); };
  const dot = (pass, bgPair, bgOut) => {
    pass.setPipeline(pDot); pass.setBindGroup(0, bgPair); pass.dispatchWorkgroups(numWG);
    pass.setPipeline(pRed); pass.setBindGroup(0, bgOut); pass.dispatchWorkgroups(1);
  };

  const staging = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  async function readScalar(src) {
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, staging, 0, 4);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const v = new Float32Array(staging.getMappedRange().slice(0))[0];
    staging.unmap();
    return v;
  }

  // preamble: Ap = A x ; r = b - Ap ; z = r.*diagInv ; rz = dot(r,z) ; bnorm2 = dot(b,b) ; p = z
  {
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pSpmv); pass.setBindGroup(0, bgSpmvX); pass.dispatchWorkgroups(vWG);
    vec(pass, pSub, bgSubR);
    vec(pass, pMul, bgMulZ);
    dot(pass, bgDotRZ, bgRedRZ);
    dot(pass, bgDotBB, bgRedBB);
    pass.end();
    enc.copyBufferToBuffer(gZ, 0, gP, 0, n * 4);
    device.queue.submit([enc.finish()]);
  }
  const bnorm = Math.sqrt(await readScalar(sBnorm)) || 1;

  // One CG iteration encoded into an existing compute pass. WebGPU tracks
  // storage-buffer hazards between dispatches in a pass, so the scalar chain
  // (pap → alpha → x/r update → rzNew → beta → p) stays correct even when many
  // iterations are batched into a single submit.
  const encodeIter = (pass) => {
    pass.setPipeline(pSpmv); pass.setBindGroup(0, bgSpmvP); pass.dispatchWorkgroups(vWG); // Ap = A p
    dot(pass, bgDotPAp, bgRedPAp);                              // pap = p·Ap
    pass.setPipeline(pAlpha); pass.setBindGroup(0, bgAlpha); pass.dispatchWorkgroups(1);  // alpha = rz/pap
    vec(pass, pAxpy, bgAxpyX);                                  // x += alpha p
    vec(pass, pAxmy, bgAxmyR);                                  // r -= alpha Ap
    vec(pass, pMul, bgMulZ);                                    // z = r.*diagInv
    dot(pass, bgDotRZ, bgRedRZNew);                            // rzNew = r·z
    dot(pass, bgDotRR, bgRedRR);                               // rr = r·r
    pass.setPipeline(pBeta); pass.setBindGroup(0, bgBeta); pass.dispatchWorkgroups(1);    // beta; rz<-rzNew
    vec(pass, pXpby, bgXpbyP);                                  // p = z + beta p
  };

  let iter = 0, relRes = Infinity, best = Infinity, stall = 0;
  while (iter < maxIter) {
    // Batch CHECK_EVERY iterations into one submit (one readback per batch) — the
    // per-submit / per-readback overhead, not the GPU compute, dominates otherwise.
    const chunk = Math.min(CHECK_EVERY, maxIter - iter);
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    for (let c = 0; c < chunk; c++) encodeIter(pass);
    pass.end();
    device.queue.submit([enc.finish()]);
    iter += chunk;

    const rr = await readScalar(sRr); // residual after the last iter of the batch
    relRes = Math.sqrt(Math.max(rr, 0)) / bnorm;
    if (relRes < best * (1 - 1e-3)) { best = relRes; stall = 0; } else { stall++; }
    if (relRes <= tol || stall >= 3 || !Number.isFinite(relRes)) break;
  }

  const xStaging = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  {
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(gX, 0, xStaging, 0, n * 4);
    device.queue.submit([enc.finish()]);
  }
  await xStaging.mapAsync(GPUMapMode.READ);
  const x = Float64Array.from(new Float32Array(xStaging.getMappedRange().slice(0)));
  xStaging.unmap();

  for (const b of [gRowPtr, gColIdx, gVals, gB, gDiagInv, gX, gR, gZ, gP, gAp, gPart,
    sRz, sPap, sRzNew, sRr, sAlpha, sBeta, sBnorm, uN, uNumWG, staging, xStaging]) b.destroy();

  return { x, iterations: iter, relRes, converged: relRes <= tol };
}

/**
 * Test hook (Phase-2 verification): single GPU SpMV y = A x, y as Float64Array,
 * so a browser harness can compare the kernel directly against csrSpMV.
 */
export async function gpuSpMVOnce(csr, xArr) {
  const device = await getDevice();
  if (!device) throw new Error('WebGPU unavailable');
  const n = csr.n, nnz = csr.vals.length;
  const F = (len) => buf(device, len * 4, STORAGE);
  const gRowPtr = F(n + 1); device.queue.writeBuffer(gRowPtr, 0, csr.rowPtr);
  const gColIdx = F(nnz); device.queue.writeBuffer(gColIdx, 0, csr.colIdx);
  const gVals = F(nnz); device.queue.writeBuffer(gVals, 0, Float32Array.from(csr.vals));
  const gX = F(n); device.queue.writeBuffer(gX, 0, Float32Array.from(xArr));
  const gY = F(n);
  const uN = u32buf(device, n);
  const p = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: K_SPMV }), entryPoint: 'main' } });
  const group = device.createBindGroup({
    layout: p.getBindGroupLayout(0),
    entries: [gRowPtr, gColIdx, gVals, gX, gY, uN].map((b, i) => ({ binding: i, resource: { buffer: b } })),
  });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(p); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(n / WG));
  pass.end();
  const staging = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  enc.copyBufferToBuffer(gY, 0, staging, 0, n * 4);
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const y = Float64Array.from(new Float32Array(staging.getMappedRange().slice(0)));
  staging.unmap();
  for (const b of [gRowPtr, gColIdx, gVals, gX, gY, uN, staging]) b.destroy();
  return y;
}
