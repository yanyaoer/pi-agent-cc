// task-graph.mjs — dependency resolution + parallelizable task selection.
//
// Context-common.md contract:
//   getReadyTasks(tasks) -> task[]
//   isTaskReady(task, tasks) -> boolean

/**
 * Return the subset of `tasks` that are in "ready" status and whose
 * dependencies are all in "done" status.
 */
export function getReadyTasks(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks.filter((t) => t.status === 'ready' && _depsSatisfied(t, byId));
}

/**
 * True when the given task is in "ready" status and every declared dep is
 * marked "done" in the provided tasks list.
 */
export function isTaskReady(task, tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.status === 'ready' && _depsSatisfied(task, byId);
}

function _depsSatisfied(task, byId) {
  const deps = Array.isArray(task.deps) ? task.deps : [];
  return deps.every((d) => byId.get(d)?.status === 'done');
}

/**
 * Detect dependency cycles. Returns an array of task ids that participate in a
 * cycle, or [] when the graph is a DAG.
 */
export function findCycles(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(tasks.map((t) => [t.id, WHITE]));
  const cycle = [];

  function dfs(id, stack) {
    const c = color.get(id);
    if (c === GRAY) {
      const start = stack.indexOf(id);
      cycle.push(...stack.slice(start), id);
      return true;
    }
    if (c === BLACK) return false;
    color.set(id, GRAY);
    stack.push(id);
    const node = byId.get(id);
    for (const dep of node?.deps || []) {
      if (byId.has(dep) && dfs(dep, stack)) return true;
    }
    stack.pop();
    color.set(id, BLACK);
    return false;
  }

  for (const t of tasks) {
    if (color.get(t.id) === WHITE && dfs(t.id, [])) return cycle;
  }
  return [];
}

/**
 * Return a stable topological order of tasks (ids). Tasks with unresolved
 * upstreams come after their deps. Throws if the graph contains a cycle.
 */
export function topoSort(tasks) {
  const cycle = findCycles(tasks);
  if (cycle.length) throw new Error(`dependency cycle: ${cycle.join(' -> ')}`);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const result = [];
  const visited = new Set();
  function visit(id) {
    if (visited.has(id) || !byId.has(id)) return;
    visited.add(id);
    for (const dep of byId.get(id).deps || []) visit(dep);
    result.push(id);
  }
  for (const t of tasks) visit(t.id);
  return result;
}
