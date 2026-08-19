// pmschedule.js — the CPM scheduling engine for Project Management.
//
// Deliberately pure and framework-free: every function here takes plain data in and returns
// plain data out. Nothing in this file touches the DOM, IndexedDB, or any global app state —
// that's the whole point (see roadmap.md 4.1: "a pure, framework-free, unit-testable module
// with no DOM code in it, same isolation discipline as annotate.js from pdf.js"). pm.js is
// responsible for fetching data from DB, calling into this file, and persisting/rendering the
// result. This separation is also what makes pmschedule.test.js possible to run under plain
// Node with no browser shims at all.
//
// Scope for this pass: Finish-to-Start (FS) dependencies with lag, forward-pass auto-scheduling
// only. Late Start/Finish and total float (the backward pass) are not computed yet — a task's
// "float" isn't meaningful without knowing the project's required finish date, which isn't
// captured anywhere yet either. SS/FF/SF dependency types are stored (see db.js) but not
// scheduled by this engine — see the "not built yet" note in roadmap.md 4.1.
//
// Date handling: callers MUST pass in the same parse/format functions pm.js already uses
// (pmParseISODate / pmFormatISODate), not a second implementation. Dates are UTC-midnight
// millisecond timestamps internally so day-difference math can't be thrown off by DST —
// re-deriving that here would risk reintroducing the exact bug it was written to avoid.

const PMSchedule = {
  // Would linking predecessorId -> successorId create a cycle in the existing dependency graph?
  // existingDeps: array of {predecessorId, successorId, ...}. A cycle exists if successorId can
  // already reach predecessorId by following existing edges forward — i.e. the new edge would
  // close a loop. This mirrors the cycle guard enforced authoritatively in db.js's
  // createPMDependency; kept here too, duplicated on purpose (not imported from db.js), so this
  // file can be tested and reasoned about with zero IndexedDB/browser dependency. It's a small,
  // stable graph-reachability check with none of the subtle failure modes date math has, so the
  // usual "don't duplicate logic" concern is low risk here.
  wouldCreateCycle(existingDeps, predecessorId, successorId) {
    if (predecessorId === successorId) return true;
    const adjacency = {};
    for (const d of existingDeps) {
      (adjacency[d.predecessorId] = adjacency[d.predecessorId] || []).push(d.successorId);
    }
    const visited = new Set();
    const stack = [successorId];
    while (stack.length) {
      const node = stack.pop();
      if (node === predecessorId) return true;
      if (visited.has(node)) continue;
      visited.add(node);
      for (const next of (adjacency[node] || [])) stack.push(next);
    }
    return false;
  },

  // Forward pass. Auto-schedules any task whose FS predecessor(s) require a later start than
  // it's currently sitting at, and cascades that change to further downstream tasks in the same
  // pass (topological order handles multi-level chains without needing separate recursion).
  //
  // Design, per the user's explicit decision: this only ever pushes a task LATER, never pulls
  // it earlier. A task with float (start later than the earliest possible date) keeps whatever
  // manual buffer the user chose — the engine only intervenes when a predecessor's finish date
  // moves far enough that the task's current start would violate the dependency.
  //
  // tasks: array of LEAF task objects only ({id, name, start, finish, duration, isMilestone}) —
  // summary tasks aren't independently dated and aren't valid dependency endpoints in this pass.
  // deps: array of {predecessorId, successorId, type, lagDays}. Only type === 'FS' is scheduled.
  // dateFns: { parse(str) -> ms|null, format(ms) -> str }.
  //
  // Returns: array of { id, start, finish } for every task that actually moved, in the order
  // they were resolved (predecessors before successors) — pm.js persists these and can report
  // "also moved: X, Y" to the user.
  computeForwardPass(tasks, deps, dateFns) {
    const { parse, format } = dateFns;
    const taskMap = new Map(tasks.map((t) => [t.id, { ...t }]));

    const fsDeps = deps.filter((d) => d.type === 'FS' && taskMap.has(d.predecessorId) && taskMap.has(d.successorId));
    const incomingByTask = {};
    const adjacency = {};
    const inDegree = {};
    for (const t of tasks) inDegree[t.id] = 0;
    for (const d of fsDeps) {
      (incomingByTask[d.successorId] = incomingByTask[d.successorId] || []).push(d);
      (adjacency[d.predecessorId] = adjacency[d.predecessorId] || []).push(d.successorId);
      inDegree[d.successorId] = (inDegree[d.successorId] || 0) + 1;
    }

    // Kahn's algorithm for topological order. If a cycle somehow exists anyway (it shouldn't —
    // db.js refuses to create one), any leftover tasks are appended in their original order
    // rather than silently dropped, so this never throws or hangs.
    const inDegreeCopy = { ...inDegree };
    const queue = tasks.filter((t) => inDegreeCopy[t.id] === 0).map((t) => t.id);
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const next of (adjacency[id] || [])) {
        inDegreeCopy[next]--;
        if (inDegreeCopy[next] === 0) queue.push(next);
      }
    }
    for (const t of tasks) if (!order.includes(t.id)) order.push(t.id);

    const changed = [];
    for (const id of order) {
      const task = taskMap.get(id);
      const incoming = incomingByTask[id] || [];
      if (incoming.length === 0) continue; // no predecessors — never auto-moved

      let requiredStartMs = null;
      for (const dep of incoming) {
        const pred = taskMap.get(dep.predecessorId);
        if (!pred || !pred.finish) continue;
        const predFinishMs = parse(pred.finish);
        if (predFinishMs == null) continue;
        // FS: successor can't start until the day after the predecessor finishes, shifted by lag.
        const candidateMs = predFinishMs + 86400000 + (dep.lagDays || 0) * 86400000;
        if (requiredStartMs == null || candidateMs > requiredStartMs) requiredStartMs = candidateMs;
      }
      if (requiredStartMs == null) continue;

      const currentStartMs = task.start ? parse(task.start) : null;
      if (currentStartMs != null && currentStartMs >= requiredStartMs) continue; // already satisfies it, has float — leave alone

      const durationDays = task.isMilestone ? 0 : Math.max(0, task.duration || 0);
      const newStartMs = requiredStartMs;
      const newFinishMs = task.isMilestone ? newStartMs : newStartMs + Math.max(0, durationDays - 1) * 86400000;
      const newStart = format(newStartMs);
      const newFinish = format(newFinishMs);
      if (newStart !== task.start || newFinish !== task.finish) {
        task.start = newStart;
        task.finish = newFinish;
        changed.push({ id, start: newStart, finish: newFinish });
      }
    }
    return changed;
  },

  // Validates a proposed manual start-date edit against a task's existing FS predecessors,
  // without mutating anything. A task can always be pushed later than the minimum (using up
  // float) but never earlier than what its predecessors require.
  // Returns { ok: true } or { ok: false, minStart: 'YYYY-MM-DD', blockedBy: 'predecessor name' }.
  validateManualStart(taskId, proposedStart, tasks, deps, dateFns) {
    const { parse, format } = dateFns;
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const incoming = deps.filter((d) => d.successorId === taskId && d.type === 'FS');

    let minStartMs = null, blockedBy = null;
    for (const dep of incoming) {
      const pred = taskMap.get(dep.predecessorId);
      if (!pred || !pred.finish) continue;
      const predFinishMs = parse(pred.finish);
      if (predFinishMs == null) continue;
      const candidateMs = predFinishMs + 86400000 + (dep.lagDays || 0) * 86400000;
      if (minStartMs == null || candidateMs > minStartMs) { minStartMs = candidateMs; blockedBy = pred.name; }
    }
    if (minStartMs == null) return { ok: true };

    const proposedMs = parse(proposedStart);
    if (proposedMs == null || proposedMs < minStartMs) {
      return { ok: false, minStart: format(minStartMs), blockedBy };
    }
    return { ok: true };
  }
};

if (typeof window !== 'undefined') window.PMSchedule = PMSchedule;
if (typeof module !== 'undefined' && module.exports) module.exports = PMSchedule;
