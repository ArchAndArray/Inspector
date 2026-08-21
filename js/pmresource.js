// pmresource.js — pure resource/effort math for Project Management.
// No DOM, no IndexedDB. Same discipline as pmcalendar.js/pmschedule.js — plain data in, plain
// data out, independently testable.
//
// Core idea, per the user's explicit design: effort is stored canonically as HOURS on an
// assignment, regardless of which of three ways it was entered (% of task duration, days of
// effort, or hours directly). All three are just different views of the same number, converted
// through "how many working hours does this specific task run per day" — which is either the
// task's own override (e.g. a 12-hour night-shift task) or the project calendar's default
// (e.g. 7.4hrs), never something this module decides on its own; the caller always resolves
// that first and passes it in as `hoursPerDay`.
//
// Scope, stated explicitly: resources share the ONE project calendar (no per-resource
// individual calendars yet — a real brief feature, deliberately deferred, not dropped).
// Resources are assignable to LEAF, non-milestone tasks only — a milestone is a marker/event
// with no duration, so "effort spent on it" isn't a meaningful concept, consistent with
// milestones already being exempt from calendar-day scheduling logic.

function pmEffortHoursFromPercent(durationWorkingDays, pct, hoursPerDay) {
  return Math.max(0, durationWorkingDays) * Math.max(0, hoursPerDay) * (pct / 100);
}
function pmEffortHoursFromDays(days, hoursPerDay) {
  return Math.max(0, days) * Math.max(0, hoursPerDay);
}
function pmPercentFromEffortHours(hours, durationWorkingDays, hoursPerDay) {
  const capacity = durationWorkingDays * hoursPerDay;
  if (capacity <= 0) return 0;
  return (hours / capacity) * 100;
}
function pmDaysFromEffortHours(hours, hoursPerDay) {
  if (hoursPerDay <= 0) return 0;
  return hours / hoursPerDay;
}

// Cost of a single assignment, given the resource's rate and how it's interpreted.
// 'hourly': effort hours x rate. 'daily': effort converted to working days x rate (a day-rate
// resource is paid per day worked, not per hour, so partial-day effort still costs per full
// rate-day here — a deliberate simplification, not a bug: real day-rate contracts are rarely
// pro-rated by the hour). 'fixed': the rate itself, a flat lump sum regardless of effort hours
// — effort can still be recorded for scheduling/workload purposes, it just doesn't affect cost.
function pmComputeAssignmentCost(assignment, resource, hoursPerDay) {
  if (resource.costRate == null) return 0;
  const rateType = resource.costRateType || 'hourly';
  if (rateType === 'fixed') return resource.costRate;
  if (rateType === 'daily') return pmDaysFromEffortHours(assignment.effortHours, hoursPerDay) * resource.costRate;
  return assignment.effortHours * resource.costRate; // hourly
}

// Sums cost across every assignment for one task. assignments should already be filtered to
// this task's id; resourceMap: { [resourceId]: resource }.
function pmComputeTaskCost(taskAssignments, resourceMap, hoursPerDay) {
  return taskAssignments.reduce((sum, a) => {
    const resource = resourceMap[a.resourceId];
    if (!resource) return sum;
    return sum + pmComputeAssignmentCost(a, resource, hoursPerDay);
  }, 0);
}

// Converts an effort value between entry modes ('pct' | 'days' | 'hours') given a task's
// duration (working days) and applicable hoursPerDay. Used by the effort-entry toggle so
// switching modes converts the current number instead of clearing it.
function pmConvertEffort(value, fromMode, toMode, durationWorkingDays, hoursPerDay) {
  if (fromMode === toMode) return value;
  let hours;
  if (fromMode === 'pct') hours = pmEffortHoursFromPercent(durationWorkingDays, value, hoursPerDay);
  else if (fromMode === 'days') hours = pmEffortHoursFromDays(value, hoursPerDay);
  else hours = value;

  if (toMode === 'pct') return pmPercentFromEffortHours(hours, durationWorkingDays, hoursPerDay);
  if (toMode === 'days') return pmDaysFromEffortHours(hours, hoursPerDay);
  return hours;
}

// Computes per-resource, per-working-day committed hours across a project, and flags days
// where a resource's combined commitments exceed their daily capacity (the project calendar's
// hoursPerDay, since resources share the one project calendar in this pass).
//
// assignments: [{ id, taskId, resourceId, effortHours }]
// tasks: LEAF tasks only ({ id, start, finish, duration, isMilestone })
// calendar: the project's calendar (for working-day iteration + default hoursPerDay)
// getTaskHoursPerDay(task): resolves a task's applicable hoursPerDay (its own override, or the
//   calendar default) — passed in as a function so this module never has to know the override
//   field's name or the fallback rule itself; that resolution logic lives in pm.js.
// dateFns: { parse, format } — the same shared pmdate.js functions used everywhere else.
// PMCalendarRef: the calendar module itself, passed in rather than required, so this file has
//   no hard import-order dependency — mirrors how pmschedule.js references PMCalendar.
//
// Returns: { [resourceId]: { days: [{ date, hours, capacity, overallocated }], totalHours } }
function pmComputeWorkload(assignments, tasks, calendar, getTaskHoursPerDay, dateFns, PMCalendarRef) {
  const { parse, format } = dateFns;
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const capacity = calendar.hoursPerDay || 7.4;

  // Per-resource, per-date hour totals.
  const byResource = {};

  for (const a of assignments) {
    const task = taskMap.get(a.taskId);
    if (!task || task.isMilestone || !task.start || !task.finish) continue;
    const s = parse(task.start), f = parse(task.finish);
    if (s == null || f == null) continue;

    const taskHoursPerDay = getTaskHoursPerDay(task);
    const workingDayDates = [];
    let cur = s;
    let guard = 0;
    while (cur <= f && guard < 3660) {
      if (PMCalendarRef.isWorkingDay(cur, calendar)) workingDayDates.push(cur);
      cur += 86400000;
      guard++;
    }
    if (workingDayDates.length === 0) continue;
    const hoursPerWorkingDay = a.effortHours / workingDayDates.length;

    if (!byResource[a.resourceId]) byResource[a.resourceId] = {};
    for (const dayMs of workingDayDates) {
      const key = format(dayMs);
      byResource[a.resourceId][key] = (byResource[a.resourceId][key] || 0) + hoursPerWorkingDay;
    }
  }

  const result = {};
  for (const resourceId of Object.keys(byResource)) {
    const dayMap = byResource[resourceId];
    const days = Object.keys(dayMap).sort().map((date) => ({
      date,
      hours: dayMap[date],
      capacity,
      overallocated: dayMap[date] > capacity + 0.001 // small epsilon for float rounding
    }));
    const totalHours = days.reduce((sum, d) => sum + d.hours, 0);
    result[resourceId] = { days, totalHours };
  }
  return result;
}

const PMResource = {
  effortHoursFromPercent: pmEffortHoursFromPercent,
  effortHoursFromDays: pmEffortHoursFromDays,
  percentFromEffortHours: pmPercentFromEffortHours,
  daysFromEffortHours: pmDaysFromEffortHours,
  convertEffort: pmConvertEffort,
  computeWorkload: pmComputeWorkload,
  computeAssignmentCost: pmComputeAssignmentCost,
  computeTaskCost: pmComputeTaskCost
};

if (typeof window !== 'undefined') window.PMResource = PMResource;
if (typeof module !== 'undefined' && module.exports) module.exports = PMResource;
