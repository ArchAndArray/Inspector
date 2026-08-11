// bci.js - General Inspection (BCI) scoring engine: CSS/UK Bridges Group Bridge Condition
// Indicators methodology, plus a parallel house-developed MDCI variant. Single source of
// truth used by both the live in-app summary (app.js) and the PDF export (pdf.js).

const BCI_ELEMENT_TYPES = [
  { key: 'primary_deck', label: 'Primary deck element', importance: 'Very High', critical: true },
  { key: 'secondary_deck', label: 'Secondary deck element', importance: 'High', critical: true },
  { key: 'half_joint', label: 'Half-joint', importance: 'Very High', critical: true },
  { key: 'bearings', label: 'Bearings', importance: 'High', critical: false },
  { key: 'tie_beam', label: 'Tie beam/rod', importance: 'Very High', critical: true },
  { key: 'parapet_beam', label: 'Parapet beam/cantilever', importance: 'Very High', critical: true },
  { key: 'pier_column', label: 'Pier/column', importance: 'Very High', critical: true },
  { key: 'cross_head', label: 'Cross-head/capping beam', importance: 'Very High', critical: true },
  { key: 'abutment', label: 'Abutment', importance: 'High', critical: false },
  { key: 'wing_wall', label: 'Wing wall', importance: 'Medium', critical: false },
  { key: 'bearing_shelf', label: 'Bearing shelf/bed', importance: 'Medium', critical: false },
  { key: 'deck_waterproofing', label: 'Deck waterproofing', importance: 'Medium', critical: false },
  { key: 'expansion_joint', label: 'Expansion joint', importance: 'Medium', critical: false },
  { key: 'drainage', label: 'Drainage', importance: 'Low', critical: false },
  { key: 'finishes_parapets', label: 'Finishes: parapets/safety fences', importance: 'Low', critical: false },
  { key: 'finishes_deck', label: 'Finishes: deck elements', importance: 'Low', critical: false },
  { key: 'finishes_substructure', label: 'Finishes: substructure elements', importance: 'Low', critical: false },
  { key: 'other', label: 'Other', importance: null, critical: false }
];

function bciElementTypeInfo(key) {
  return BCI_ELEMENT_TYPES.find((t) => t.key === key) || null;
}

// Builds the small descriptive line shown under an element's name — Element Type for
// GI Bridges inspections, Material/Location for everything else.
function elementSublineParts(elmt, isGiBridges) {
  if (isGiBridges) {
    const info = bciElementTypeInfo(elmt.elementType);
    const parts = [info ? info.label : null, elmt.importance || null];
    if (elmt.notInspected) parts.push('Not inspected');
    return parts.filter(Boolean);
  }
  return [elmt.materialType, elmt.location].filter(Boolean);
}

const BCI_IMPORTANCE_LEVELS = ['Very High', 'High', 'Medium', 'Low'];
const BCI_EIF = { 'Very High': 2.0, High: 1.5, Medium: 1.2, Low: 1.0 };

// Element Condition Score lookup: Severity (1-5) x Extent (A-E).
// Severity 5 is treated as ECS 5.0 regardless of extent, per the standard's own note that
// 5B/5C/5D/5E don't meaningfully differ (only 5C is populated in the source table).
const BCI_ECS_TABLE = {
  A: { 1: 1.0 },
  B: { 1: 1.0, 2: 2.0, 3: 3.0, 4: 4.0 },
  C: { 1: 1.1, 2: 2.1, 3: 3.1, 4: 4.1, 5: 5.0 },
  D: { 1: 1.3, 2: 2.3, 3: 3.3, 4: 4.3 },
  E: { 1: 1.7, 2: 2.7, 3: 3.7, 4: 4.7 }
};

function bciEcsFor(severity, extent) {
  if (!severity || !extent) return null;
  if (severity === 5) return 5.0;
  const row = BCI_ECS_TABLE[extent];
  if (!row || row[severity] == null) return null;
  return row[severity];
}

// Severity/Extent combinations that are not permissible (Severity > 1 with "no significant
// defect" extent). Used to validate the Finding editor's chip pickers everywhere in the app.
function bciIsValidSeverityExtent(severity, extent) {
  if (!severity || !extent) return true; // incomplete selection isn't yet invalid
  if (extent === 'A' && severity > 1) return false;
  return true;
}

// ---- Vanilla (official) element ECS: dominant-defect check, else an approximate
// interacting-defects rule (escalate extent one band when severities tie for worst). ----
function bciVanillaElementECS(defects) {
  const valid = defects.filter((d) => d.severity && d.extent && bciEcsFor(d.severity, d.extent) != null);
  if (!valid.length) return 1.0; // no logged defects = as-new
  const maxSev = Math.max(...valid.map((d) => d.severity));
  const atMax = valid.filter((d) => d.severity === maxSev);
  if (atMax.length === 1) {
    // Dominant defect (or the only defect) sets the element's ECS outright.
    return bciEcsFor(atMax[0].severity, atMax[0].extent);
  }
  // Interacting case: 2+ defects share the worst severity — escalate the worst of their
  // extents one band (capped at E). Approximate; see UI/PDF note.
  const extentOrder = ['A', 'B', 'C', 'D', 'E'];
  const worstExtentIdx = Math.max(...atMax.map((d) => extentOrder.indexOf(d.extent)));
  const escalatedIdx = Math.min(worstExtentIdx + 1, extentOrder.length - 1);
  return bciEcsFor(maxSev, extentOrder[escalatedIdx]);
}

// ---- MDCI (house) element ECS: ranked, weighted blend of all defects. ----
function bciMdciElementECS(defects) {
  const valid = defects
    .filter((d) => d.severity && d.extent)
    .map((d) => ({ ecs: bciEcsFor(d.severity, d.extent) }))
    .filter((d) => d.ecs != null)
    .sort((a, b) => b.ecs - a.ecs);
  if (!valid.length) return 1.0; // no logged defects = as-new
  if (valid.length === 1) return valid[0].ecs;
  if (valid.length === 2) return 0.7 * valid[0].ecs + 0.3 * valid[1].ecs;
  const rest = valid.slice(1);
  const sumSq = rest.reduce((s, d) => s + d.ecs * d.ecs, 0);
  const sum = rest.reduce((s, d) => s + d.ecs, 0);
  const weighted = sum > 0 ? sumSq / sum : 0;
  return 0.7 * valid[0].ecs + 0.3 * weighted;
}

// ---- Shared ECF -> ECI -> BCS -> BCI pipeline (run separately for each track). ----
function bciEcf(importance, ecs) {
  switch (importance) {
    case 'Very High': return 0.0;
    case 'High': return 0.3 - ((ecs - 1) * 0.3) / 4;
    case 'Medium': return 0.6 - ((ecs - 1) * 0.6) / 4;
    case 'Low': return 1.2 - ((ecs - 1) * 1.2) / 4;
    default: return 0;
  }
}
function bciEci(ecs, importance) {
  return Math.max(ecs - bciEcf(importance, ecs), 1.0);
}
function bciBcsToBci(bcs) {
  if (bcs == null) return null;
  return 100 - 2 * (Math.pow(bcs, 2) + 6.5 * bcs - 7.5);
}

// ---- Full inspection-level summary, one track at a time. ----
// entries: [{ elementId, elementTypeKey, importance, ecs }]
function bciAggregateTrack(entries) {
  if (!entries.length) return { bcsAv: null, bcsCrit: null, bciAv: null, bciCrit: null };

  const withEci = entries.map((e) => ({ ...e, eci: bciEci(e.ecs, e.importance) }));

  // Half-joint / primary-deck-element dedup: both types describe the same physical
  // structure, so only the worse of the two contributes to the average — but every
  // instance of either still competes independently for the critical (max) figure.
  const dedupPool = ['primary_deck', 'half_joint'];
  const inDedup = withEci.filter((e) => dedupPool.includes(e.elementTypeKey));
  const outsideDedup = withEci.filter((e) => !dedupPool.includes(e.elementTypeKey));
  let averageSet = outsideDedup;
  if (inDedup.length) {
    const worst = inDedup.reduce((a, b) => (b.eci > a.eci ? b : a));
    averageSet = outsideDedup.concat([worst]);
  }

  const weightSum = averageSet.reduce((s, e) => s + (BCI_EIF[e.importance] || 0), 0);
  const weighted = averageSet.reduce((s, e) => s + e.eci * (BCI_EIF[e.importance] || 0), 0);
  const bcsAv = weightSum > 0 ? weighted / weightSum : null;

  const criticalEntries = withEci.filter((e) => {
    const info = bciElementTypeInfo(e.elementTypeKey);
    return info && info.critical;
  });
  const bcsCrit = criticalEntries.length ? Math.max(...criticalEntries.map((e) => e.eci)) : null;

  return {
    bcsAv,
    bcsCrit,
    bciAv: bcsAv != null ? bciBcsToBci(bcsAv) : null,
    bciCrit: bcsCrit != null ? bciBcsToBci(bcsCrit) : null
  };
}

// Computes the full BCI/MDCI summary for an inspection. Fetches its own data so it can be
// called identically from the live in-app card and the PDF export.
async function computeBciSummary(inspectionId) {
  const elements = await DB.listElements(inspectionId);
  const eligible = elements.filter((e) => e.elementType && !e.notInspected);

  const vanillaEntries = [];
  const mdciEntries = [];
  for (const el of eligible) {
    const findings = await DB.listFindings(el.id);
    const defects = findings.map((f) => ({ severity: f.severity, extent: f.extent }));
    const importance = el.importance || (bciElementTypeInfo(el.elementType) || {}).importance || 'Low';
    vanillaEntries.push({ elementId: el.id, elementTypeKey: el.elementType, importance, ecs: bciVanillaElementECS(defects) });
    mdciEntries.push({ elementId: el.id, elementTypeKey: el.elementType, importance, ecs: bciMdciElementECS(defects) });
  }

  return {
    elementCount: eligible.length,
    excludedCount: elements.length - eligible.length,
    vanilla: bciAggregateTrack(vanillaEntries),
    mdci: bciAggregateTrack(mdciEntries)
  };
}
