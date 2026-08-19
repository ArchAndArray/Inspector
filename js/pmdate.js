// pmdate.js — the ONLY place ISO date parsing/formatting/diffing for the PM module lives.
// Pure, no DOM. Used by pm.js (browser), pmschedule.js (CPM engine), and pmschedule.test.js
// (plain Node) — this exists specifically so the CPM engine can never end up with a second,
// slightly different way of handling dates than the task table/Gantt already use. Dates are
// parsed as UTC midnight throughout so day-difference math can't be thrown off by DST.

function pmParseISODate(str) {
  if (!str) return null;
  const [y, m, d] = str.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return Date.UTC(y, m - 1, d);
}

function pmFormatISODate(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function pmDaysBetween(aMs, bMs) { return Math.round((bMs - aMs) / 86400000); }

const PMDate = { parseISODate: pmParseISODate, formatISODate: pmFormatISODate, daysBetween: pmDaysBetween };

if (typeof window !== 'undefined') {
  window.pmParseISODate = pmParseISODate;
  window.pmFormatISODate = pmFormatISODate;
  window.pmDaysBetween = pmDaysBetween;
  window.PMDate = PMDate;
}
if (typeof module !== 'undefined' && module.exports) module.exports = PMDate;
