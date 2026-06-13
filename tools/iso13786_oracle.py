#!/usr/bin/env python3
"""ISO 13786 transfer-matrix oracle for PHASOR's harmonic solver (gate G2.2).

INDEPENDENT of the app: this is the 1D analytic transfer-matrix method
(complex 2x2 layer matrices), a completely different numerical path than the
3D Galerkin FEM in src/. A bug in one cannot hide in the other.

Convention e^{+i w t} (DESIGN.md SS2.6). Complex wavenumber per layer
    k = (1 + i) / delta,   delta = sqrt(2 a / w),   a = lambda / (rho c)
Single-layer transfer matrix relating state s = (T_hat, q_hat) on the two
faces, with q_hat = -lambda dT/dx the flux in the +x (external->internal)
direction (derived from T = A cosh(kx) + B sinh(kx)):

    [T(d)]   [   cosh(kd)      -sinh(kd)/(lambda k) ] [T(0)]
    [q(d)] = [ -lambda k sinh(kd)     cosh(kd)      ] [q(0)]

Surface film of resistance R is the pure-resistance matrix [[1, -R], [0, 1]].

The SIGN CONVENTION is not taken on faith from the doc: the built-in
semi-infinite self-test below asserts that a thick layer reproduces the
closed form  T(x) = A e^{-x/delta} cos(w t - x/delta)  -- amplitude decaying
and phase LAGGING with depth. If k had the wrong sign this test fails loudly.

Pure standard library (cmath); no numpy needed. Run:  python tools/iso13786_oracle.py
"""

import cmath
import math

OMEGA_ANNUAL = 2 * math.pi / 31_557_600.0   # rad/s  (~1.991e-7)
OMEGA_DIURNAL = 2 * math.pi / 86_400.0       # rad/s  (~7.272e-5)

# Same material values as src/model.mjs (lambda [W/mK], rho [kg/m3], c [J/kgK]).
MATERIALS = {
    "concrete": (2.1, 2400, 1000),
    "brick":    (0.70, 1800, 1000),
    "eps":      (0.035, 20, 1450),
    "plaster":  (0.51, 1300, 1000),
}

# Default wall1d build-up, exterior -> interior (matches model.mjs).
DEFAULT_LAYERS = [("eps", 0.16), ("brick", 0.24), ("plaster", 0.015)]


def penetration_depth(material, omega):
    lam, rho, c = MATERIALS[material]
    a = lam / (rho * c)
    return math.sqrt(2 * a / omega)


def _mat_mul(A, B):
    return [
        [A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1]],
        [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1]],
    ]


def _mat_vec(A, v):
    return [A[0][0] * v[0] + A[0][1] * v[1], A[1][0] * v[0] + A[1][1] * v[1]]


def layer_matrix(material, thickness, omega):
    lam = MATERIALS[material][0]
    delta = penetration_depth(material, omega)
    k = (1 + 1j) / delta
    kd = k * thickness
    ckd, skd = cmath.cosh(kd), cmath.sinh(kd)
    return [[ckd, -skd / (lam * k)], [-lam * k * skd, ckd]]


def film_matrix(R):
    return [[1 + 0j, -R + 0j], [0 + 0j, 1 + 0j]]


def solve_wall(layers, omega, R_se, R_si, T_e, T_i):
    """Solve the 1D periodic BVP. Returns a list of nodes external->internal:
    (label, x, T_hat, q_hat). Node order:
      external air (x=0), external surface, interface_1, ..., internal surface,
      internal air. Heat capacity means q is NOT conserved across layers."""
    mats, labels, dx = [], [], []
    mats.append(film_matrix(R_se)); labels.append("ext_surface"); dx.append(0.0)
    for i, (mat, d) in enumerate(layers):
        mats.append(layer_matrix(mat, d, omega))
        labels.append(f"interface_{i + 1}" if i + 1 < len(layers) else "int_surface")
        dx.append(d)
    mats.append(film_matrix(R_si)); labels.append("internal_air"); dx.append(0.0)

    # total transfer external air -> internal air, to back out the surface flux
    Z = [[1 + 0j, 0], [0, 1 + 0j]]
    for M in mats:
        Z = _mat_mul(M, Z)
    q_e = (T_i - Z[0][0] * T_e) / Z[0][1]

    nodes = [("external_air", 0.0, T_e, q_e)]
    v, x = [T_e, q_e], 0.0
    for M, label, d in zip(mats, labels, dx):
        v = _mat_vec(M, v)
        x += d
        nodes.append((label, x, v[0], v[1]))
    return nodes


def lag_seconds(T_hat, omega):
    """Time lag tau = -arg(T_hat)/omega, normalized to [0, period)."""
    return (-cmath.phase(T_hat) / omega) % (2 * math.pi / omega)


# --------------------------------------------------------------- self-tests

def _check_penetration_depths():
    # DESIGN.md SS2.3 table: concrete delta ~ 0.155 m diurnal, ~2.96 m annual.
    dd = penetration_depth("concrete", OMEGA_DIURNAL)
    da = penetration_depth("concrete", OMEGA_ANNUAL)
    assert abs(dd - 0.155) < 0.005, f"concrete diurnal delta {dd:.4f} != ~0.155"
    assert abs(da - 2.96) < 0.05, f"concrete annual delta {da:.3f} != ~2.96"
    assert abs(da / dd - math.sqrt(365.25)) < 1e-6, "delta ratio != sqrt(365.25)"
    print(f"[ok] penetration depth: concrete diurnal {dd:.4f} m, annual {da:.3f} m")


def _check_semi_infinite():
    """A thick layer must reproduce A e^{-x/delta} cos(wt - x/delta): amplitude
    decays as e^{-x/delta}, phase LAGS as x/delta. This pins the sign of k to
    physics, independent of the app AND of the doc."""
    omega = OMEGA_DIURNAL
    delta = penetration_depth("concrete", omega)
    sub = delta / 8
    n = 120  # total depth 15*delta -- far Dirichlet sink is negligible near front
    layers = [("concrete", sub)] * n
    nodes = solve_wall(layers, omega, R_se=0.0, R_si=0.0, T_e=1 + 0j, T_i=0 + 0j)

    # surface (R_se=0 so external surface == external air == 1.0, phase 0)
    surf = next(t for (lbl, x, t, q) in nodes if lbl == "ext_surface")
    assert abs(abs(surf) - 1.0) < 1e-9 and abs(cmath.phase(surf)) < 1e-9

    # Test depths up to 3*delta: below pi rad of lag, so cmath.phase (which
    # wraps at +-pi) needs no unwrapping. At 3*delta amplitude is already e^-3.
    worst_amp, worst_lag, prev_lag = 0.0, 0.0, -1.0
    for (lbl, x, T, q) in nodes:
        if not lbl.startswith(("interface", "int_surface")):
            continue
        if x > 3 * delta:
            continue
        amp_err = abs(abs(T) - math.exp(-x / delta))
        lag = -cmath.phase(T)          # expected x/delta
        lag_err = abs(lag - x / delta)
        worst_amp = max(worst_amp, amp_err)
        worst_lag = max(worst_lag, lag_err)
        assert lag > prev_lag - 1e-12, f"phase not increasing inward at x={x:.3f}"
        prev_lag = lag
    assert worst_amp < 1e-2, f"amplitude vs e^-x/delta off by {worst_amp:.2e}"
    assert worst_lag < 1e-2, f"phase lag vs x/delta off by {worst_lag:.2e} rad"
    print(f"[ok] semi-infinite: max amplitude err {worst_amp:.2e}, "
          f"max lag err {worst_lag:.2e} rad (decays + lags inward)")


def _report_default_wall():
    """Print the G2.2 reference: inner-surface transfer ratio (T_innersurface /
    T_external_air) for the default wall, internal air held constant (T_i=0)."""
    print("\nG2.2 reference -- default wall1d (eps0.16/brick0.24/plaster0.015), "
          "R_se=0.04, R_si=0.13, internal air constant:")
    for name, omega, unit, scale in [
        ("annual", OMEGA_ANNUAL, "days", 86_400.0),
        ("diurnal", OMEGA_DIURNAL, "hours", 3_600.0),
    ]:
        nodes = solve_wall(DEFAULT_LAYERS, omega, 0.04, 0.13, T_e=1 + 0j, T_i=0 + 0j)
        T_is = next(t for (lbl, x, t, q) in nodes if lbl == "int_surface")
        tau = lag_seconds(T_is, omega) / scale
        print(f"  {name:8s}: |T_is/T_e| = {abs(T_is):.6e}  "
              f"arg = {math.degrees(cmath.phase(T_is)):+8.3f} deg  "
              f"time lag = {tau:7.3f} {unit}")


if __name__ == "__main__":
    _check_penetration_depths()
    _check_semi_infinite()
    _report_default_wall()
    print("\nAll self-tests passed. Numbers above are the independent G2.2 oracle.")
