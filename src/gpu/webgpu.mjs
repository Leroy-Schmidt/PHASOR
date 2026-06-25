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
import { assembleCSR, assembleCSRImag } from '../fem.mjs';

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
      // The harmonic complex SpMV needs 10 storage buffers/stage (the spec floor
      // is 8); request the adapter's full reported limit so it's available where
      // the hardware allows. The steady path uses only 5, so adapters capped at 8
      // still get GPU steady — gpuSolveHarmonic guards on the limit and falls back.
      const maxSB = adapter.limits.maxStorageBuffersPerShaderStage;
      return await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: maxSB } });
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

// ===================================================================== HARMONIC
// Complex-symmetric COCG on the GPU (S2-M2.2 Phase H). The operator is
// A = (K+H) + i·ωC: real part = assembleCSR (identity rows), imaginary part =
// assembleCSRImag (ωC, empty non-free rows). COCG uses the UNCONJUGATED bilinear
// form Σ uᵢvᵢ (complex); the residual test uses the true conjugated norm Σ|rᵢ|².
// fp32 floor ~1e-4 with no breakdown (Phase-H0 probe) → tol 1e-4 + stagnation-stop.

// complex SpMV: (yRe,yIm) = (Are + i·Aim)(xRe + i·xIm), one row per invocation
const K_SPMV_C = /* wgsl */`
@group(0) @binding(0) var<storage, read> rpRe : array<u32>;
@group(0) @binding(1) var<storage, read> ciRe : array<u32>;
@group(0) @binding(2) var<storage, read> vRe  : array<f32>;
@group(0) @binding(3) var<storage, read> rpIm : array<u32>;
@group(0) @binding(4) var<storage, read> ciIm : array<u32>;
@group(0) @binding(5) var<storage, read> vIm  : array<f32>;
@group(0) @binding(6) var<storage, read> xRe  : array<f32>;
@group(0) @binding(7) var<storage, read> xIm  : array<f32>;
@group(0) @binding(8) var<storage, read_write> yRe : array<f32>;
@group(0) @binding(9) var<storage, read_write> yIm : array<f32>;
@group(0) @binding(10) var<uniform> N : u32;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) g : vec3<u32>) {
  let r = g.x; if (r >= N) { return; }
  var areXr=0.0; var areXi=0.0; let e1=rpRe[r+1u];
  for (var p=rpRe[r]; p<e1; p=p+1u) { let c=ciRe[p]; let a=vRe[p]; areXr=areXr+a*xRe[c]; areXi=areXi+a*xIm[c]; }
  var aimXr=0.0; var aimXi=0.0; let e2=rpIm[r+1u];
  for (var p=rpIm[r]; p<e2; p=p+1u) { let c=ciIm[p]; let a=vIm[p]; aimXr=aimXr+a*xRe[c]; aimXi=aimXi+a*xIm[c]; }
  yRe[r] = areXr - aimXi;   // Are·xRe − Aim·xIm
  yIm[r] = areXi + aimXr;   // Are·xIm + Aim·xRe
}`;

// complex unconjugated bilinear Σ a·b → two partials (re, im)
const K_BILIN = /* wgsl */`
@group(0) @binding(0) var<storage, read> ar : array<f32>;
@group(0) @binding(1) var<storage, read> ai : array<f32>;
@group(0) @binding(2) var<storage, read> br : array<f32>;
@group(0) @binding(3) var<storage, read> bi : array<f32>;
@group(0) @binding(4) var<storage, read_write> pRe : array<f32>;
@group(0) @binding(5) var<storage, read_write> pIm : array<f32>;
@group(0) @binding(6) var<uniform> N : u32;
var<workgroup> sr : array<f32, ${WG}>;
var<workgroup> si : array<f32, ${WG}>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid:vec3<u32>, @builtin(local_invocation_id) lid:vec3<u32>, @builtin(workgroup_id) wid:vec3<u32>) {
  let i=gid.x; var vr=0.0; var vi=0.0;
  if (i<N) { vr = ar[i]*br[i]-ai[i]*bi[i]; vi = ar[i]*bi[i]+ai[i]*br[i]; }
  sr[lid.x]=vr; si[lid.x]=vi; workgroupBarrier();
  var stride:u32=${HALF}u;
  loop { if (stride==0u){break;} if (lid.x<stride){ sr[lid.x]=sr[lid.x]+sr[lid.x+stride]; si[lid.x]=si[lid.x]+si[lid.x+stride]; } workgroupBarrier(); stride=stride/2u; }
  if (lid.x==0u){ pRe[wid.x]=sr[0]; pIm[wid.x]=si[0]; }
}`;

// reduce the two partials arrays → out[0]=Σre, out[1]=Σim
const K_REDUCE2 = /* wgsl */`
@group(0) @binding(0) var<storage, read> pRe : array<f32>;
@group(0) @binding(1) var<storage, read> pIm : array<f32>;
@group(0) @binding(2) var<storage, read_write> outv : array<f32>;
@group(0) @binding(3) var<uniform> M : u32;
var<workgroup> sr : array<f32, ${WG}>;
var<workgroup> si : array<f32, ${WG}>;
@compute @workgroup_size(${WG})
fn main(@builtin(local_invocation_id) lid:vec3<u32>) {
  var vr=0.0; var vi=0.0; var i:u32=lid.x;
  loop { if (i>=M){break;} vr=vr+pRe[i]; vi=vi+pIm[i]; i=i+${WG}u; }
  sr[lid.x]=vr; si[lid.x]=vi; workgroupBarrier();
  var stride:u32=${HALF}u;
  loop { if (stride==0u){break;} if (lid.x<stride){ sr[lid.x]=sr[lid.x]+sr[lid.x+stride]; si[lid.x]=si[lid.x]+si[lid.x+stride]; } workgroupBarrier(); stride=stride/2u; }
  if (lid.x==0u){ outv[0]=sr[0]; outv[1]=si[0]; }
}`;

// true conjugated squared-norm partials Σ(rr²+ri²)
const K_NORM2 = /* wgsl */`
@group(0) @binding(0) var<storage, read> rr : array<f32>;
@group(0) @binding(1) var<storage, read> ri : array<f32>;
@group(0) @binding(2) var<storage, read_write> part : array<f32>;
@group(0) @binding(3) var<uniform> N : u32;
var<workgroup> s : array<f32, ${WG}>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid:vec3<u32>, @builtin(local_invocation_id) lid:vec3<u32>, @builtin(workgroup_id) wid:vec3<u32>) {
  let i=gid.x; var v=0.0; if (i<N){ v = rr[i]*rr[i]+ri[i]*ri[i]; }
  s[lid.x]=v; workgroupBarrier();
  var stride:u32=${HALF}u;
  loop { if (stride==0u){break;} if (lid.x<stride){ s[lid.x]=s[lid.x]+s[lid.x+stride]; } workgroupBarrier(); stride=stride/2u; }
  if (lid.x==0u){ part[wid.x]=s[0]; }
}`;

// complex Jacobi precond: z = r / (diagRe + i·diagIm)
const K_CPREC = /* wgsl */`
@group(0) @binding(0) var<storage, read_write> zr : array<f32>;
@group(0) @binding(1) var<storage, read_write> zi : array<f32>;
@group(0) @binding(2) var<storage, read> rr : array<f32>;
@group(0) @binding(3) var<storage, read> ri : array<f32>;
@group(0) @binding(4) var<storage, read> dr : array<f32>;
@group(0) @binding(5) var<storage, read> di : array<f32>;
@group(0) @binding(6) var<uniform> N : u32;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) g:vec3<u32>) {
  let i=g.x; if (i>=N){return;} let a=dr[i]; let b=di[i]; let den=a*a+b*b;
  zr[i] = (rr[i]*a + ri[i]*b)/den;
  zi[i] = (ri[i]*a - rr[i]*b)/den;
}`;

// complex saxpy family. s is a length-2 complex scalar [re, im].
const csaxpy = (body) => /* wgsl */`
@group(0) @binding(0) var<storage, read_write> ar : array<f32>;
@group(0) @binding(1) var<storage, read_write> ai : array<f32>;
@group(0) @binding(2) var<storage, read> br : array<f32>;
@group(0) @binding(3) var<storage, read> bi : array<f32>;
@group(0) @binding(4) var<storage, read> s : array<f32>;
@group(0) @binding(5) var<uniform> N : u32;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) g:vec3<u32>) { let i=g.x; if (i>=N){return;} let s0=s[0]; let s1=s[1]; ${body} }`;
const K_CAXPY = csaxpy('ar[i]=ar[i]+(s0*br[i]-s1*bi[i]); ai[i]=ai[i]+(s0*bi[i]+s1*br[i]);'); // x += alpha p
const K_CAXMY = csaxpy('ar[i]=ar[i]-(s0*br[i]-s1*bi[i]); ai[i]=ai[i]-(s0*bi[i]+s1*br[i]);'); // r -= alpha q
const K_CXPBY = csaxpy('let or=ar[i]; let oi=ai[i]; ar[i]=br[i]+(s0*or-s1*oi); ai[i]=bi[i]+(s0*oi+s1*or);'); // p = z + beta p

// complex divide out = a / b   (a,b,out are length-2 [re,im])
const K_CDIV = /* wgsl */`
@group(0) @binding(0) var<storage, read> a : array<f32>;
@group(0) @binding(1) var<storage, read> b : array<f32>;
@group(0) @binding(2) var<storage, read_write> outv : array<f32>;
@compute @workgroup_size(1)
fn main() { let den=b[0]*b[0]+b[1]*b[1]; let ok = den!=0.0;
  outv[0]=select(0.0,(a[0]*b[0]+a[1]*b[1])/den,ok);
  outv[1]=select(0.0,(a[1]*b[0]-a[0]*b[1])/den,ok); }`;
// beta = rzNew / rz, then rz <- rzNew (all length-2 complex)
const K_CBETA = /* wgsl */`
@group(0) @binding(0) var<storage, read_write> rz : array<f32>;
@group(0) @binding(1) var<storage, read> rzN : array<f32>;
@group(0) @binding(2) var<storage, read_write> beta : array<f32>;
@compute @workgroup_size(1)
fn main() { let d=rz[0]*rz[0]+rz[1]*rz[1]; let ok=d!=0.0;
  beta[0]=select(0.0,(rzN[0]*rz[0]+rzN[1]*rz[1])/d,ok);
  beta[1]=select(0.0,(rzN[1]*rz[0]-rzN[0]*rz[1])/d,ok);
  rz[0]=rzN[0]; rz[1]=rzN[1]; }`;

/**
 * GPU-resident fp32 COCG for the harmonic complex-symmetric system. Mirrors the
 * CPU `cocg` (src/solver.mjs). Returns the complex solution as two Float64Arrays.
 *
 * @param {object} problem — from assemble()
 * @param {number} omega
 * @param {{bRe:Float64Array,bIm:Float64Array,diagRe:Float64Array,diagIm:Float64Array,tol?:number,maxIter?:number}} o
 * @returns {Promise<{xRe:Float64Array,xIm:Float64Array,iterations:number,relRes:number,converged:boolean}>}
 */
export async function gpuSolveHarmonic(problem, omega, { bRe, bIm, diagRe, diagIm, tol = 1e-4, maxIter = 6000 } = {}) {
  const device = await getDevice();
  if (!device) throw new Error('WebGPU unavailable');
  // complex SpMV (K_SPMV_C) binds 10 storage buffers; bail to CPU if the device
  // can't (the invalid-pipeline path otherwise no-ops silently → zero field).
  if (device.limits.maxStorageBuffersPerShaderStage < 10) throw new Error('GPU storage-buffer limit too low for complex SpMV');

  const csrRe = assembleCSR(problem);
  const csrIm = assembleCSRImag(problem, omega);
  const n = csrRe.n;
  const numWG = Math.ceil(n / WG);
  const vWG = numWG;

  const F = (len) => buf(device, len * 4, STORAGE);
  const up = (b, arr) => device.queue.writeBuffer(b, 0, arr);
  // CSR (real + imag), as fp32
  const rpRe = F(n + 1); up(rpRe, csrRe.rowPtr); const ciRe = F(csrRe.colIdx.length || 1); up(ciRe, csrRe.colIdx); const vRe = F(csrRe.vals.length || 1); up(vRe, Float32Array.from(csrRe.vals));
  const rpIm = F(n + 1); up(rpIm, csrIm.rowPtr); const ciIm = F(csrIm.colIdx.length || 1); up(ciIm, csrIm.colIdx); const vIm = F(csrIm.vals.length || 1); up(vIm, Float32Array.from(csrIm.vals));
  const gBr = F(n); up(gBr, Float32Array.from(bRe)); const gBi = F(n); up(gBi, Float32Array.from(bIm));
  const gDr = F(n); up(gDr, Float32Array.from(diagRe)); const gDi = F(n); up(gDi, Float32Array.from(diagIm));
  const gXr = F(n); const gXi = F(n); // harmonic initial guess is 0 (matches CPU cocg)
  const gRr = F(n), gRi = F(n), gZr = F(n), gZi = F(n), gPr = F(n), gPi = F(n), gQr = F(n), gQi = F(n);
  const gPartRe = F(numWG), gPartIm = F(numWG), gPart = F(numWG);
  const sRz = F(2), sPq = F(2), sRzN = F(2), sAlpha = F(2), sBeta = F(2), sRr = F(1), sBn = F(1);
  const uN = u32buf(device, n), uNumWG = u32buf(device, numWG);

  const pipe = (code) => device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  const pSpmv = pipe(K_SPMV_C), pBil = pipe(K_BILIN), pRed2 = pipe(K_REDUCE2), pNorm = pipe(K_NORM2),
    pPrec = pipe(K_CPREC), pAxpy = pipe(K_CAXPY), pAxmy = pipe(K_CAXMY), pXpby = pipe(K_CXPBY),
    pDiv = pipe(K_CDIV), pBeta = pipe(K_CBETA), pRed1 = pipe(K_REDUCE);

  const bg = (pl, bufs) => device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: bufs.map((b, i) => ({ binding: i, resource: { buffer: b } })) });
  const bgSpmvX = bg(pSpmv, [rpRe, ciRe, vRe, rpIm, ciIm, vIm, gXr, gXi, gQr, gQi, uN]);
  const bgSpmvP = bg(pSpmv, [rpRe, ciRe, vRe, rpIm, ciIm, vIm, gPr, gPi, gQr, gQi, uN]);
  const bgPrec = bg(pPrec, [gZr, gZi, gRr, gRi, gDr, gDi, uN]);
  const bgBilRZ = bg(pBil, [gRr, gRi, gZr, gZi, gPartRe, gPartIm, uN]);
  const bgBilPQ = bg(pBil, [gPr, gPi, gQr, gQi, gPartRe, gPartIm, uN]);
  const bgRed2RZ = bg(pRed2, [gPartRe, gPartIm, sRz, uNumWG]);
  const bgRed2PQ = bg(pRed2, [gPartRe, gPartIm, sPq, uNumWG]);
  const bgRed2RZN = bg(pRed2, [gPartRe, gPartIm, sRzN, uNumWG]);
  const bgNormBB = bg(pNorm, [gBr, gBi, gPart, uN]);
  const bgNormRR = bg(pNorm, [gRr, gRi, gPart, uN]);
  const bgRedBB = bg(pRed1, [gPart, sBn, uNumWG]);
  const bgRedRR = bg(pRed1, [gPart, sRr, uNumWG]);
  const bgAlpha = bg(pDiv, [sRz, sPq, sAlpha]);
  const bgAxpyX = bg(pAxpy, [gXr, gXi, gPr, gPi, sAlpha, uN]);
  const bgAxmyR = bg(pAxmy, [gRr, gRi, gQr, gQi, sAlpha, uN]);
  const bgBeta = bg(pBeta, [sRz, sRzN, sBeta]);
  const bgXpbyP = bg(pXpby, [gPr, gPi, gZr, gZi, sBeta, uN]);

  const vec = (pass, pl, group) => { pass.setPipeline(pl); pass.setBindGroup(0, group); pass.dispatchWorkgroups(vWG); };
  const bil = (pass, bgIn, bgOut) => { pass.setPipeline(pBil); pass.setBindGroup(0, bgIn); pass.dispatchWorkgroups(numWG); pass.setPipeline(pRed2); pass.setBindGroup(0, bgOut); pass.dispatchWorkgroups(1); };
  const norm = (pass, bgIn, bgOut) => { pass.setPipeline(pNorm); pass.setBindGroup(0, bgIn); pass.dispatchWorkgroups(numWG); pass.setPipeline(pRed1); pass.setBindGroup(0, bgOut); pass.dispatchWorkgroups(1); };

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

  // preamble: q=A x ; r=b−q ; z=M⁻¹r ; rz=bilinear(r,z) ; bnorm²=‖b‖² ; p=z.
  // r=b−q is done as r←b (copy) then r −= 1·q via K_CAXMY with alpha=[1,0].
  device.queue.writeBuffer(sAlpha, 0, new Float32Array([1, 0]));
  {
    const enc = device.createCommandEncoder();
    const p1 = enc.beginComputePass();
    p1.setPipeline(pSpmv); p1.setBindGroup(0, bgSpmvX); p1.dispatchWorkgroups(vWG); // q = A x
    p1.end();
    enc.copyBufferToBuffer(gBr, 0, gRr, 0, n * 4);
    enc.copyBufferToBuffer(gBi, 0, gRi, 0, n * 4);
    const p2 = enc.beginComputePass();
    vec(p2, pAxmy, bgAxmyR);     // r = b − q
    vec(p2, pPrec, bgPrec);      // z = M⁻¹ r
    bil(p2, bgBilRZ, bgRed2RZ);  // rz = r·z (bilinear)
    norm(p2, bgNormBB, bgRedBB); // ‖b‖²
    p2.end();
    enc.copyBufferToBuffer(gZr, 0, gPr, 0, n * 4); // p = z
    enc.copyBufferToBuffer(gZi, 0, gPi, 0, n * 4);
    device.queue.submit([enc.finish()]);
  }
  const bnorm = Math.sqrt(await readScalar(sBn)) || 1;

  const encodeIter = (pass) => {
    pass.setPipeline(pSpmv); pass.setBindGroup(0, bgSpmvP); pass.dispatchWorkgroups(vWG); // q = A p
    bil(pass, bgBilPQ, bgRed2PQ);                       // pq = p·q (bilinear)
    pass.setPipeline(pDiv); pass.setBindGroup(0, bgAlpha); pass.dispatchWorkgroups(1);    // alpha = rz/pq
    vec(pass, pAxpy, bgAxpyX);                           // x += alpha p
    vec(pass, pAxmy, bgAxmyR);                           // r -= alpha q
    vec(pass, pPrec, bgPrec);                            // z = M⁻¹ r
    bil(pass, bgBilRZ, bgRed2RZN);                      // rzNew = r·z
    norm(pass, bgNormRR, bgRedRR);                      // ‖r‖²
    pass.setPipeline(pBeta); pass.setBindGroup(0, bgBeta); pass.dispatchWorkgroups(1);    // beta; rz<-rzNew
    vec(pass, pXpby, bgXpbyP);                           // p = z + beta p
  };

  let iter = 0, relRes = Infinity, best = Infinity, stall = 0;
  while (iter < maxIter) {
    const chunk = Math.min(CHECK_EVERY, maxIter - iter);
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    for (let c = 0; c < chunk; c++) encodeIter(pass);
    pass.end();
    device.queue.submit([enc.finish()]);
    iter += chunk;
    const rr = await readScalar(sRr);
    relRes = Math.sqrt(Math.max(rr, 0)) / bnorm;
    if (relRes < best * (1 - 1e-3)) { best = relRes; stall = 0; } else { stall++; }
    if (relRes <= tol || stall >= 3 || !Number.isFinite(relRes)) break;
  }

  const readVec = async (src) => {
    const st = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(src, 0, st, 0, n * 4); device.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const out = Float64Array.from(new Float32Array(st.getMappedRange().slice(0)));
    st.unmap(); st.destroy();
    return out;
  };
  const xRe = await readVec(gXr);
  const xIm = await readVec(gXi);

  for (const b of [rpRe, ciRe, vRe, rpIm, ciIm, vIm, gBr, gBi, gDr, gDi, gXr, gXi, gRr, gRi, gZr, gZi, gPr, gPi, gQr, gQi,
    gPartRe, gPartIm, gPart, sRz, sPq, sRzN, sAlpha, sBeta, sRr, sBn, uN, uNumWG, staging]) b.destroy();
  return { xRe, xIm, iterations: iter, relRes, converged: relRes <= tol };
}

/**
 * Test hook (Phase-H verification): single complex GPU SpMV (yRe,yIm) = A (xRe,xIm)
 * via K_SPMV_C, so a browser harness can compare it against csrSpMVComplex.
 */
export async function gpuSpMVComplexOnce(csrRe, csrIm, xRe, xIm) {
  const device = await getDevice();
  if (!device) throw new Error('WebGPU unavailable');
  const n = csrRe.n;
  const F = (len) => buf(device, len * 4, STORAGE);
  const up = (b, a) => device.queue.writeBuffer(b, 0, a);
  const rpRe = F(n + 1); up(rpRe, csrRe.rowPtr); const ciRe = F(csrRe.colIdx.length || 1); up(ciRe, csrRe.colIdx); const vRe = F(csrRe.vals.length || 1); up(vRe, Float32Array.from(csrRe.vals));
  const rpIm = F(n + 1); up(rpIm, csrIm.rowPtr); const ciIm = F(csrIm.colIdx.length || 1); up(ciIm, csrIm.colIdx); const vIm = F(csrIm.vals.length || 1); up(vIm, Float32Array.from(csrIm.vals));
  const gXr = F(n); up(gXr, Float32Array.from(xRe)); const gXi = F(n); up(gXi, Float32Array.from(xIm));
  const gYr = F(n), gYi = F(n);
  const uN = u32buf(device, n);
  const p = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: K_SPMV_C }), entryPoint: 'main' } });
  const group = device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [rpRe, ciRe, vRe, rpIm, ciIm, vIm, gXr, gXi, gYr, gYi, uN].map((b, i) => ({ binding: i, resource: { buffer: b } })) });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass(); pass.setPipeline(p); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(n / WG)); pass.end();
  device.queue.submit([enc.finish()]);
  const read = async (src) => { const st = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); const e = device.createCommandEncoder(); e.copyBufferToBuffer(src, 0, st, 0, n * 4); device.queue.submit([e.finish()]); await st.mapAsync(GPUMapMode.READ); const o = Float64Array.from(new Float32Array(st.getMappedRange().slice(0))); st.unmap(); st.destroy(); return o; };
  const yRe = await read(gYr); const yIm = await read(gYi);
  for (const b of [rpRe, ciRe, vRe, rpIm, ciIm, vIm, gXr, gXi, gYr, gYi, uN]) b.destroy();
  return { yRe, yIm };
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
