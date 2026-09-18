// ============================================================================
// UK Highway Retaining Wall Design — calculation engine
// Mirrors the validated Excel workbook formula-for-formula.
//
// Earth-pressure coefficients (Ka;β, Ka;δw, the long/short-heel blend, and the
// optional Sd;K model factor) follow the derivation in:
//   Denton, Christie, Shave & Kidd, "PD 6694-1: Recommendations for the design
//   of structures subject to traffic loading to EN1997-1", clauses 4.7,
//   7.2.3, 7.2.4, and Appendix 1 (equations A9, A10, A15).
// Validated against the paper's own worked examples (see calc_test.js /
// pd6694_test.js): Example 1 (long heel, β=20°,φ'=35° → Ka;β=0.302, paper
// states 0.30) and Example 2 (short heel, blended Ka;CD=0.309, paper states
// 0.307 — difference is rounding in the paper's hand-worked wedge check).
// ============================================================================
const D2R = Math.PI / 180;
const cot = (deg) => 1 / Math.tan(deg * D2R);

function factorPhi(phiDeg, gammaPhi) {
  return Math.atan(Math.tan(phiDeg * D2R) / gammaPhi) / D2R;
}

// eq (A9): critical wedge angle psi, for delta=beta on the vertical virtual plane
function psiAngle(phiDeg, betaDeg) {
  const phi = phiDeg * D2R, beta = betaDeg * D2R;
  return 0.5 * (90 + phiDeg - betaDeg + Math.asin(Math.sin(beta) / Math.sin(phi)) / D2R);
}
// eq (A10)
function epsAngle(phiDeg, betaDeg) {
  return 90 + phiDeg - psiAngle(phiDeg, betaDeg);
}
// eq (A15): Ka;beta - the "long heel" active pressure coefficient (delta=beta
// on the vertical virtual plane), valid provided the heel/back-face geometry
// satisfies alpha < psi.
function kaBetaCoulomb(phiDeg, betaDeg) {
  const eps = epsAngle(phiDeg, betaDeg);
  const beta = betaDeg * D2R, phi = phiDeg * D2R, epsR = eps * D2R;
  const num = Math.cos(epsR) * Math.cos(beta);
  const den = Math.sin(epsR - beta) * (Math.tan(beta) + 1 / Math.tan(epsR - phi));
  return num / den;
}
// Standard Coulomb active pressure coefficient for a VERTICAL wall face
// (theta=0), backfill slope beta, wall friction delta — used for Ka;deltaw,
// the "short heel" limit (alpha=90 deg) where the virtual plane coincides
// with a true soil-to-wall interface over its full height.
function kaCoulombVertical(phiDeg, betaDeg, deltaDeg) {
  const phi = phiDeg * D2R, beta = betaDeg * D2R, delta = deltaDeg * D2R;
  const num = Math.cos(phi) * Math.cos(phi);
  const inner = Math.sqrt((Math.sin(phi + delta) * Math.sin(phi - beta)) / (Math.cos(delta) * Math.cos(beta)));
  const den = Math.cos(delta) * Math.pow(1 + inner, 2);
  return num / den;
}
// Long-heel / short-heel Ka;CD per PD 6694-1 cl 7.2.3/7.2.4: alpha is the
// angle the wall's own back face makes with the horizontal (90 deg = fully
// vertical back face / no heel). Returns Ka;CD plus the intermediate values
// for display.
function kaLongOrShortHeel(phiDeg, betaDeg, deltaWDeg, alphaDegRaw) {
  const alphaDeg = Math.min(alphaDegRaw, 90);
  const psi = psiAngle(phiDeg, betaDeg);
  const kaBeta = kaBetaCoulomb(phiDeg, betaDeg);
  const kaDeltaW = kaCoulombVertical(phiDeg, betaDeg, deltaWDeg);
  let kaCD, longHeel;
  if (alphaDeg < psi) {
    kaCD = kaBeta; longHeel = true;
  } else if (deltaWDeg > betaDeg) {
    // PD 6694-1: if delta_w > beta, Ka;CD theoretically reduces below Ka;beta
    // as alpha increases — the PD recommends using Ka;beta for all alpha.
    kaCD = kaBeta; longHeel = false;
  } else {
    const alphaCapped = Math.min(alphaDeg, 80); // PD 6694-1 cl 7.2.4 cap
    const frac = (alphaCapped - psi) / (90 - psi);
    kaCD = kaBeta + (kaDeltaW - kaBeta) * Math.max(0, frac);
    longHeel = false;
  }
  return { psi, kaBeta, kaDeltaW, kaCD, longHeel, alphaDeg };
}

function rankineKp(phiDegDesign) {
  const p = phiDegDesign * D2R;
  return (1 + Math.sin(p)) / (1 - Math.sin(p));
}

// ---- derived (Inputs sheet, section 5 & 6) -------------------------------
function computeDerived(inp) {
  const factors = {
    C1: { gG: 1.35, gGfav: 1.0, gQ: 1.5, gPhi: 1.0, gC: 1.0, gRv: 1.0, gRh: 1.0 },
    C2: { gG: 1.0, gGfav: 1.0, gQ: 1.3, gPhi: 1.25, gC: 1.25, gRv: 1.0, gRh: 1.0 },
  };
  const d = { factors, sdk: inp.applyModelFactor ? 1.2 : 1.0 };
  for (const c of ['C1', 'C2']) {
    const f = factors[c];
    const phid = factorPhi(inp.phi, f.gPhi);
    const phifd = factorPhi(inp.phif, f.gPhi);
    const cfd = inp.cf / f.gC;
    const deltad = factorPhi(inp.delta, f.gPhi);
    const deltaWd = factorPhi(inp.deltaW, f.gPhi);
    const Kp = rankineKp(phifd);
    d[c] = { phid, phifd, cfd, deltad, deltaWd, Kp };
  }
  d.fctm = 0.3 * Math.pow(inp.fck, 2 / 3);
  return d;
}

// ---- shared bearing-capacity (EC7 Annex D) block --------------------------
function bearingResistance(N, Hd, Bp, phifd, cfd, gammaf, Df, gRv) {
  const Nq = Math.exp(Math.PI * Math.tan(phifd * D2R)) * Math.pow(Math.tan((45 + phifd / 2) * D2R), 2);
  const Nc = phifd === 0 ? Math.PI + 2 : (Nq - 1) * cot(phifd);
  const Ng = 2 * (Nq - 1) * Math.tan(phifd * D2R);
  const qOb = gammaf * Df;
  const denom = phifd === 0 ? N : N + Bp * cfd * cot(phifd);
  const iq = Math.pow(1 - Hd / denom, 2);
  const ig = Math.pow(1 - Hd / denom, 3);
  const RA = cfd * Nc * iq + qOb * Nq * iq + 0.5 * gammaf * Bp * Ng * ig;
  const R = (RA * Bp) / gRv;
  return { Nq, Nc, Ng, qOb, denom, iq, ig, RA, R };
}

function eccentricityAndPressures(N, Mr, Mot, B) {
  const e = B / 2 - (Mr - Mot) / N;
  const eB6 = e <= B / 6;
  const eB3 = e <= B / 3;
  const Bp = B - 2 * e;
  const qmax = eB6 ? (N / B) * (1 + (6 * e) / B) : (2 * N) / (3 * (B / 2 - e));
  const qmin = eB6 ? (N / B) * (1 - (6 * e) / B) : 0;
  return { e, eB6, eB3, Bp, qmax, qmin };
}

// ---- MASS WALL -------------------------------------------------------------
function computeMassWall(inp, geo, d) {
  const { H, b1, B, Df } = geo;
  const Ar = b1 * H, At = 0.5 * (B - b1) * H, Aw = Ar + At;
  const Ww = Aw * inp.gammac;
  const xr = b1 / 2, xt = (2 * b1 + B) / 3, xw = (Ar * xr + At * xt) / Aw;
  const Asw = 0.5 * (B - b1) * H, Wsw = Asw * inp.gamma, xsw = (b1 + 2 * B) / 3;
  const Qsw = inp.q * (B - b1);
  // alpha: angle of the wall's own battered back face from horizontal
  const alphaDeg = (B - b1) <= 1e-9 ? 90 : Math.atan(H / (B - b1)) / D2R;
  // height of the vertical virtual plane where sloping backfill rises across
  // the wedge width (B-b1) before reaching it (PD 6694-1 worked example method)
  const CDh = H + (B - b1) * Math.tan(inp.beta * D2R);

  const out = { Ar, At, Aw, Ww, xr, xt, xw, Asw, Wsw, xsw, Qsw, alphaDeg, CDh, combos: {} };
  for (const c of ['C1', 'C2']) {
    const f = d.factors[c], dc = d[c];
    const kaInfo = kaLongOrShortHeel(dc.phid, inp.beta, dc.deltaWd, alphaDeg);
    const Ka = kaInfo.kaCD;

    const PaSoilK = 0.5 * Ka * inp.gamma * CDh * CDh * d.sdk;
    const PaSoilD = PaSoilK * f.gG;
    const PaQK = Ka * inp.q * CDh;
    const PaQD = PaQK * f.gQ;
    const Hd = PaSoilD + PaQD + inp.Htop * f.gQ;

    const N = Ww * f.gGfav + Wsw * f.gGfav + inp.Vtop * f.gQ;
    const Mr = Ww * f.gGfav * xw + Wsw * f.gGfav * xsw + inp.Vtop * f.gQ * xw;
    const Mot = PaSoilD * (CDh / 3) + PaQD * (CDh / 2) + inp.Htop * f.gQ * CDh;
    const ecc = eccentricityAndPressures(N, Mr, Mot, B);

    const bearing = bearingResistance(N, Hd, ecc.Bp, dc.phifd, dc.cfd, inp.gammaf, Df, f.gRv);
    const qEd = N / ecc.Bp;

    const Rfriction = N * Math.tan(dc.deltad * D2R);
    const Pp = 0.5 * dc.Kp * inp.gammaf * Df * Df * inp.PPfac;
    const Rslide = (Rfriction + Pp) / f.gRh;

    out.combos[c] = {
      ...kaInfo, Ka, PaSoilK, PaSoilD, PaQK, PaQD, Hd,
      N, Mr, Mot, ...ecc, qEd,
      ...bearing, bearingCheck: N <= bearing.R,
      Rfriction, Pp, Rslide, slideCheck: Hd <= Rslide,
    };
  }
  return out;
}

// ---- RC design block (EC2) -------------------------------------------------
function rcDesignBlock(thicknessM, MEd, VEd, dia, spacing, inp, d) {
  const cover = inp.cover;
  const dEff = thicknessM * 1000 - cover - dia / 2;
  const Asprov = (Math.PI / 4) * dia * dia * (1000 / spacing);
  const K = (MEd * 1e6) / (1000 * dEff * dEff * inp.fck);
  const Kprime = 0.168;
  const z = Math.min(dEff * (0.5 + Math.sqrt(0.25 - K / 1.134)), 0.95 * dEff);
  const Asreq = (MEd * 1e6) / (0.87 * inp.fyk * z);
  const Asmin = Math.max(0.26 * (d.fctm / inp.fyk) * 1000 * dEff, 0.0013 * 1000 * dEff);
  const kCheck = K <= Kprime;
  const asCheck = Asprov >= Math.max(Asreq, Asmin);

  const kShear = Math.min(1 + Math.sqrt(200 / dEff), 2.0);
  const rhol = Math.min(Asprov / (1000 * dEff), 0.02);
  const VRdc = Math.max(0.12 * kShear * Math.pow(100 * rhol * inp.fck, 1 / 3),
    0.035 * Math.pow(kShear, 1.5) * Math.sqrt(inp.fck)) * 1000 * dEff / 1000;
  const vCheck = VEd <= VRdc;

  const Mqp = MEd / 1.35;
  const sigs = (Mqp * 1e6) / (Asprov * z);
  let maxSpacing;
  if (sigs <= 160) maxSpacing = 300;
  else if (sigs <= 200) maxSpacing = 250;
  else if (sigs <= 240) maxSpacing = 200;
  else if (sigs <= 280) maxSpacing = 150;
  else if (sigs <= 320) maxSpacing = 100;
  else if (sigs <= 360) maxSpacing = 50;
  else maxSpacing = 0;
  const crackCheck = spacing <= maxSpacing;

  return {
    MEd, VEd, dia, spacing, dEff, Asprov, K, Kprime, z, Asreq, Asmin, kCheck, asCheck,
    kShear, rhol, VRdc, vCheck, Mqp, sigs, maxSpacing, crackCheck,
  };
}

// ---- CANTILEVER WALL --------------------------------------------------------
function computeCantileverWall(inp, geo, d, rebar) {
  const { hs, ts, tb, Lt, Lh, Df } = geo;
  const B = Lt + ts + Lh;
  const H = hs + tb;
  const xStemBack = Lt + ts;

  const Wstem = ts * hs * inp.gammac, xStem = Lt + ts / 2;
  const Wbase = B * tb * inp.gammac, xBase = B / 2;
  const Wsoil = Lh * hs * inp.gamma, xSoil = xStemBack + Lh / 2;
  const Qheel = inp.q * Lh;
  // Virtual plane through the back of the heel: standard, code-recognised
  // ("long heel") treatment, valid provided the heel is long enough that the
  // failure wedge from the heel doesn't intersect the stem — checked below
  // via the classical Rankine failure-plane rule (45+phi'/2 from horizontal).
  const CDh = H + Lh * Math.tan(inp.beta * D2R);

  const out = { B, H, xStemBack, Wstem, xStem, Wbase, xBase, Wsoil, xSoil, Qheel, CDh, combos: {} };
  const MEdStem = {}, VEdStem = {}, MEdHeel = {}, VEdHeel = {}, MEdToe = {}, VEdToe = {};

  for (const c of ['C1', 'C2']) {
    const f = d.factors[c], dc = d[c];
    const Ka = kaBetaCoulomb(dc.phid, inp.beta);
    const heelMin = H / Math.tan((45 + dc.phid / 2) * D2R);
    const heelCheck = Lh >= heelMin;

    const PaSoilK = 0.5 * Ka * inp.gamma * CDh * CDh * d.sdk;
    const PaSoilD = PaSoilK * f.gG;
    const PaQK = Ka * inp.q * CDh;
    const PaQD = PaQK * f.gQ;
    const Hd = PaSoilD + PaQD + inp.Htop * f.gQ;

    const N = (Wstem + Wbase + Wsoil) * f.gGfav + inp.Vtop * f.gQ;
    const Mr = (Wstem * xStem + Wbase * xBase + Wsoil * xSoil) * f.gGfav + inp.Vtop * f.gQ * xStem;
    const Mot = PaSoilD * (CDh / 3) + PaQD * (CDh / 2) + inp.Htop * f.gQ * CDh;
    const ecc = eccentricityAndPressures(N, Mr, Mot, B);

    const bearing = bearingResistance(N, Hd, ecc.Bp, dc.phifd, dc.cfd, inp.gammaf, Df, f.gRv);
    const qEd = N / ecc.Bp;

    const Rfriction = N * Math.tan(dc.deltad * D2R);
    const Pp = 0.5 * dc.Kp * inp.gammaf * Df * Df * inp.PPfac;
    const Rslide = (Rfriction + Pp) / f.gRh;

    // stem local bending (pressure over hs only)
    const Mstem = (0.5 * Ka * inp.gamma * hs * hs * (hs / 3) * d.sdk) * f.gG
      + (Ka * inp.q * hs * (hs / 2)) * f.gQ;
    const Vstem = (0.5 * Ka * inp.gamma * hs * hs * d.sdk) * f.gG + (Ka * inp.q * hs) * f.gQ;
    MEdStem[c] = Mstem; VEdStem[c] = Vstem;

    // heel local bending (about back of stem) — bearing pressure under heel conservatively = 0
    const Mheel = ((Wsoil / Lh) * Lh * Lh / 2) * f.gG + (inp.q * Lh * Lh / 2) * f.gQ
      + ((Wbase / B) * Lh * Lh / 2) * f.gG;
    const Vheel = Wsoil * f.gG + (inp.q * Lh) * f.gQ + ((Wbase / B) * Lh) * f.gG;
    MEdHeel[c] = Mheel; VEdHeel[c] = Vheel;

    // toe local bending — uses ACTUAL max edge pressure (fixed)
    const wnet = ecc.qmax - tb * inp.gammac;
    const Mtoe = wnet * Lt * Lt / 2;
    const Vtoe = wnet * Lt;
    MEdToe[c] = Mtoe; VEdToe[c] = Vtoe;

    out.combos[c] = {
      Ka, heelMin, heelCheck, PaSoilK, PaSoilD, PaQK, PaQD, Hd,
      N, Mr, Mot, ...ecc, qEd,
      ...bearing, bearingCheck: N <= bearing.R,
      Rfriction, Pp, Rslide, slideCheck: Hd <= Rslide,
      Mstem, Vstem, Mheel, Vheel, Mtoe, Vtoe, wnet,
    };
  }

  out.stem = rcDesignBlock(ts, Math.max(MEdStem.C1, MEdStem.C2), Math.max(VEdStem.C1, VEdStem.C2),
    rebar.stem.dia, rebar.stem.spacing, inp, d);
  out.heel = rcDesignBlock(tb, Math.max(MEdHeel.C1, MEdHeel.C2), Math.max(VEdHeel.C1, VEdHeel.C2),
    rebar.heel.dia, rebar.heel.spacing, inp, d);
  out.toe = rcDesignBlock(tb, Math.max(MEdToe.C1, MEdToe.C2), Math.max(VEdToe.C1, VEdToe.C2),
    rebar.toe.dia, rebar.toe.spacing, inp, d);
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = {
    computeDerived, computeMassWall, computeCantileverWall, rcDesignBlock,
    psiAngle, epsAngle, kaBetaCoulomb, kaCoulombVertical, kaLongOrShortHeel,
  };
}
