/**
 * 探索 MCP 真實回應格式（唯讀為主）。密鑰從環境變數讀，不寫死。
 *   MCP_URL=... MCP_TOKEN=... npx tsx scripts/explore-mcp.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.MCP_URL;
const token = process.env.MCP_TOKEN;
if (!url || !token) {
  console.error('需要環境變數 MCP_URL 與 MCP_TOKEN');
  process.exit(2);
}

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'orch-explorer', version: '0.0.1' });

type CallOut = { raw: string; json: unknown };
async function call(name: string, args: Record<string, unknown> = {}): Promise<CallOut> {
  const r = (await client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
  const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
  let json: unknown;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { raw: text, json };
}

function preview(v: unknown, n = 1200): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > n ? s.slice(0, n) + `\n…(截斷，共 ${s.length} 字)` : s;
}

await client.connect(transport);
console.log('✅ 已連上 MCP\n');

// 1) 工具與 schema
const tools = await client.listTools();
console.log('=== TOOLS（名稱 + 參數）===');
for (const t of tools.tools) {
  const props = (t.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  console.log(`- ${t.name}  params=${JSON.stringify(Object.keys(props))}`);
}

// 2) list_repos
const repos = await call('handler__list_repos');
console.log('\n=== handler__list_repos ===\n' + preview(repos.json ?? repos.raw));

// 3) list_tasks（嘗試取第一個 repo 的 owner/name）
let repoStr: string | undefined;
const rj = repos.json as unknown;
if (Array.isArray(rj) && rj.length > 0) {
  const first = rj[0] as Record<string, unknown>;
  repoStr = (first.repo as string) ?? (first.owner && first.name ? `${first.owner}/${first.name}` : undefined);
}
console.log(`\n(推得 repo = ${repoStr ?? '未知，改用無參數'})`);
const tasks = await call('handler__list_tasks', repoStr ? { repo: repoStr } : {});
console.log('\n=== handler__list_tasks ===\n' + preview(tasks.json ?? tasks.raw));

// 4) get_task（取第一個任務 id）
let taskId: string | undefined;
const tj = tasks.json as unknown;
const arr = Array.isArray(tj) ? tj : (tj as { tasks?: unknown[] })?.tasks;
if (Array.isArray(arr) && arr.length > 0) {
  const t0 = arr[0] as Record<string, unknown>;
  taskId = (t0.id as string) ?? (t0.taskId as string) ?? (t0._id as string);
}
if (taskId) {
  const detail = await call('handler__get_task', { taskId });
  const detail2 = detail.json ? detail : await call('handler__get_task', { id: taskId });
  console.log(`\n=== handler__get_task(${taskId}) ===\n` + preview(detail2.json ?? detail2.raw));
} else {
  console.log('\n(無任務可 get_task)');
}

await client.close();
console.log('\n✅ 探索完成');
