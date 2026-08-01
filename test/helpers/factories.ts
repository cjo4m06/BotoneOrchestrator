import type { CheckResult, GateReport, Task, TaskDetail } from '../../src/types.js';

let seq = 0;
const nextId = (): string => `T-${(seq += 1)}`;

/** ledger 內的 Task（planner / dispatcher 測試用）。 */
export function makeTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? nextId();
  const now = Date.now();
  return {
    id,
    payloadHash: `hash-${id}`,
    repo: 'acme/web',
    category: 'dev',
    title: `任務 ${id}`,
    description: `描述 ${id}`,
    dependencies: [],
    docRefs: [],
    state: 'queued',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** MCP 回傳的 TaskDetail（worker / prompt / PR 內文測試用）。 */
export function makeTaskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  const id = overrides.id ?? nextId();
  return {
    id,
    title: `任務 ${id}`,
    status: 'in_progress',
    repo: 'acme/web',
    description: `描述 ${id}`,
    dependencies: [],
    docRefs: [],
    category: 'dev',
    ...overrides,
  };
}

/** DoD 關卡報告；預設全綠，傳 checks 可組出各種失敗組合。 */
export function makeGateReport(overrides: Partial<GateReport> = {}): GateReport {
  const checks: CheckResult[] = overrides.checks ?? [{ name: 'build', ok: true, detail: 'ok' }];
  return {
    green: overrides.green ?? checks.every((c) => c.ok),
    checks,
    signature: overrides.signature ?? checks.map((c) => `${c.name}:${c.ok ? 1 : 0}`).join('|'),
    ...(overrides.screenshots ? { screenshots: overrides.screenshots } : {}),
  };
}
