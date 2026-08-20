// pmcalendar.js — working-day calendar logic for Project Management.
// Pure, no DOM. Used by pmschedule.js (the CPM engine) and pm.js (the UI/data layer).
//
// A calendar is a plain object: { workingWeekdays: [1,2,3,4,5], holidays: ['2026-12-25', ...] }
// workingWeekdays uses JS's own getUTCDay() numbering: 0=Sun, 1=Mon, ... 6=Sat.
// holidays is a list of 'YYYY-MM-DD' strings — specific non-working dates on top of the
// weekly pattern (bank holidays etc).
//
// Design note carried over from pmschedule.js's own scope decisions: this governs ONE calendar
// per project, not multiple named calendars or per-resource calendars — those are real brief
// features (section 10) explicitly deferred, not silently dropped. See roadmap.md 4.1.

const PM_DEFAULT_CALENDAR = { workingWeekdays: [1, 2, 3, 4, 5], holidays: [] };

// The engine's own default when no calendar is supplied at all is "every day works" — this is
// NOT the same as PM_DEFAULT_CALENDAR (Mon-Fri), which is the product-level default a new
// project actually gets (set in db.js's createPMProject). Keeping the engine's own no-calendar
// default as a no-op is what lets pmschedule.js's existing Step 3 tests keep passing unchanged
// — they test dependency/cascade logic and were never meant to be calendar tests. pm.js always
// passes an explicit calendar at call time in real use.
const PM_ALL_DAYS_CALENDAR = { workingWeekdays: [0, 1, 2, 3, 4, 5, 6], holidays: [] };

function pmIsWorkingDay(ms, calendar) {
  const cal = calendar || PM_ALL_DAYS_CALENDAR;
  const weekday = new Date(ms).getUTCDay();
  if (!cal.workingWeekdays.includes(weekday)) return false;
  const dateStr = new Date(ms).toISOString().slice(0, 10);
  if (cal.holidays && cal.holidays.includes(dateStr)) return false;
  return true;
}

// If ms is already a working day, returns it unchanged. Otherwise advances forward (never
// backward — consistent with the engine's own "only ever push later" rule) to the next one.
function pmNextWorkingDay(ms, calendar) {
  let cur = ms;
  let guard = 0;
  while (!pmIsWorkingDay(cur, calendar) && guard < 3660) { // ~10 years' worth of days as a hard backstop
    cur += 86400000;
    guard++;
  }
  return cur;
}

// Given a start day (assumed already a working day — callers snap first) and a duration
// counted in working days (the start day itself counts as day 1), returns the finish day.
// durationWorkingDays must be >= 1 for a normal task; callers handle 0 (milestones) separately.
function pmAddWorkingDays(startMs, durationWorkingDays, calendar) {
  if (durationWorkingDays <= 1) return startMs;
  let cur = startMs;
  let counted = 1;
  let guard = 0;
  while (counted < durationWorkingDays && guard < 3660) {
    cur += 86400000;
    if (pmIsWorkingDay(cur, calendar)) counted++;
    guard++;
  }
  return cur;
}

// Inclusive count of working days between two days (both assumed working days themselves,
// same convention as pmAddWorkingDays — a task starting and finishing on the same working day
// has a duration of 1, not 0). Used when a resize needs to derive a new duration from a
// dragged start/finish pair.
function pmCountWorkingDays(startMs, finishMs, calendar) {
  if (finishMs <= startMs) return 1;
  let cur = startMs;
  let count = pmIsWorkingDay(startMs, calendar) ? 1 : 0;
  while (cur < finishMs) {
    cur += 86400000;
    if (pmIsWorkingDay(cur, calendar)) count++;
  }
  return Math.max(1, count);
}

const PMCalendar = {
  DEFAULT: PM_DEFAULT_CALENDAR,
  ALL_DAYS: PM_ALL_DAYS_CALENDAR,
  isWorkingDay: pmIsWorkingDay,
  nextWorkingDay: pmNextWorkingDay,
  addWorkingDays: pmAddWorkingDays,
  countWorkingDays: pmCountWorkingDays
};

if (typeof window !== 'undefined') window.PMCalendar = PMCalendar;
if (typeof module !== 'undefined' && module.exports) module.exports = PMCalendar;
