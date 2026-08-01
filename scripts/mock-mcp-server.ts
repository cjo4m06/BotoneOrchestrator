/**
 * Mock MCP server（真的 MCP 協定，stdio 傳輸）。
 *
 * 為什麼是「真的 server」而不是在測試裡塞一個假物件：這樣 daemon 那一側完全不必改，
 * 走的是正式的 PmmMcpClient → MCP 協定 → transport 這條路。除了任務**內容**是我們指定的，
 * 其餘每一段都是正式程式碼。
 *
 * 狀態存在一個 JSON 檔（ORCH_MOCK_TASKS），所以：
 *   · 外部可以觀察 start_task／complete_task 有沒有真的被呼叫、summary 寫了什麼
 *   · daemon 重啟後任務狀態不會消失（跟真的任務板一樣）
 *
 *   ORCH_MOCK_TASKS=/path/tasks.json npx tsx scripts/mock-mcp-server.ts
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync } from 'node:fs';

interface MockTask {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  repo: string;
  category: string;
  summary: string;
  assigneeId: string;
  createdAt: string;
  updatedAt: string;
  depIdList: string[];
  docRefsList: string[];
  /** complete_task 收到的總結（觀察用）。 */
  completedSummary?: string;
}

interface MockState {
  tasks: MockTask[];
  docs: Record<string, string>;
  /** 呼叫紀錄，讓外部驗證「有沒有真的照流程走」。 */
  calls: { tool: string; at: string; args: unknown }[];
}

const STATE_PATH = process.env.ORCH_MOCK_TASKS;
if (!STATE_PATH) {
  console.error('需要 ORCH_MOCK_TASKS 指向狀態檔');
  process.exit(2);
}

const read = (): MockState => JSON.parse(readFileSync(STATE_PATH, 'utf8')) as MockState;
const write = (s: MockState): void => writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));

function record(tool: string, args: unknown): MockState {
  const s = read();
  s.calls.push({ tool, at: new Date().toISOString(), args });
  write(s);
  return s;
}

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const err = (message: string, code = 'error') =>
  ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message, code }) }] });

const server = new Server({ name: 'mock-pmm', version: '1.0.0' }, { capabilities: { tools: {} } });

const TOOLS = [
  { name: 'handler__list_tasks', description: '列出任務', inputSchema: { type: 'object', properties: { repo: { type: 'string' }, status: { type: 'string' }, mine: { type: 'boolean' }, assigneeId: { type: 'string' } } } },
  { name: 'handler__get_task', description: '取得任務', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
  { name: 'handler__start_task', description: '認領任務', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
  { name: 'handler__complete_task', description: '完成任務', inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, summary: { type: 'string' } }, required: ['taskId'] } },
  { name: 'handler__read_doc', description: '讀規格', inputSchema: { type: 'object', properties: { docType: { type: 'string' }, fileName: { type: 'string' }, section: { type: 'string' } } } },
  { name: 'handler__list_docs', description: '列規格', inputSchema: { type: 'object', properties: { docType: { type: 'string' } } } },
  { name: 'handler__search_docs', description: '搜規格', inputSchema: { type: 'object', properties: { query: { type: 'string' }, docType: { type: 'string' } } } },
  { name: 'handler__list_repos', description: '列 repo', inputSchema: { type: 'object', properties: {} } },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const state = record(name, args);

  switch (name) {
    case 'handler__list_repos':
      return ok([...new Set(state.tasks.map((t) => t.repo))].map((repo) => ({ repo })));

    case 'handler__list_tasks': {
      const status = args.status as string | undefined;
      const repo = args.repo as string | undefined;
      const tasks = state.tasks.filter((t) => (!status || t.status === status) && (!repo || t.repo === repo));
      return ok({ assignee: 'mock-user', tasks });
    }

    case 'handler__get_task': {
      const t = state.tasks.find((x) => x.id === args.taskId);
      return t ? ok(t) : err(`找不到任務 ${String(args.taskId)}`, 'not_found');
    }

    case 'handler__start_task': {
      const s = read();
      const t = s.tasks.find((x) => x.id === args.taskId);
      if (!t) return err(`找不到任務 ${String(args.taskId)}`, 'not_found');
      // 真實任務板的行為：已完成的不可再認領；依賴未完成則擋下（signal → 稍後重試）
      if (t.status === 'done') return err('任務已完成', 'already_done');
      const blocking = t.depIdList.filter((d) => s.tasks.find((x) => x.id === d)?.status !== 'done');
      if (blocking.length > 0) return err(`尚有未完成的前置任務：${blocking.join(', ')}`, 'dependencies_incomplete');
      t.status = 'in_progress';
      t.updatedAt = new Date().toISOString();
      write(s);
      return ok(t);
    }

    case 'handler__complete_task': {
      const s = read();
      const t = s.tasks.find((x) => x.id === args.taskId);
      if (!t) return err(`找不到任務 ${String(args.taskId)}`, 'not_found');
      t.status = 'done';
      t.completedSummary = String(args.summary ?? '');
      t.updatedAt = new Date().toISOString();
      write(s);
      return ok({ ok: true });
    }

    case 'handler__list_docs':
      return ok(Object.keys(state.docs).map((k) => ({ fileName: k.split('/').pop(), docType: 'spec' })));

    case 'handler__search_docs':
      return ok(Object.entries(state.docs).map(([fileName, content]) => ({
        docType: 'spec', fileName, score: 1, snippet: content.slice(0, 200),
      })));

    case 'handler__read_doc': {
      // 客戶端送來的 fileName 已經去掉 docType 前綴（`spec/a.md#x` → `a.md`），
      // 所以要同時接受完整路徑與檔名；回傳欄位必須是 **body**（PmmMcpClient 取的是 j.body）。
      // 這兩點都踩過：key 對不上 ⇒ agent 拿到空規格，只靠一行 summary 亂做。
      const want = String(args.fileName ?? '');
      const key = Object.keys(state.docs).find(
        (k) => k === want || k.endsWith(`/${want}`) || k.split('/').pop() === want,
      );
      return key === undefined
        ? err(`找不到文件 ${want}`, 'not_found')
        : ok({ fileName: key, body: state.docs[key] });
    }

    default:
      return err(`未知的工具 ${name}`, 'unknown_tool');
  }
});

await server.connect(new StdioServerTransport());
