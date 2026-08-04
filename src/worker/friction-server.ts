import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '../observability/logger.js';
import { createFrictionHandler, FRICTION_KINDS, FRICTION_TOOL_DESCRIPTION, type FrictionSink } from './friction.js';

export type { FrictionSink };

/**
 * 把摩擦回報包成獨立的 in-process MCP server。
 *
 * 寫程式的 agent 是把它掛在既有的 `ask` server 底下（那裡已經有 ask_human 等出口），
 * 其他角色沒有那個 server，所以需要單獨一個。工具本身完全相同——
 * 差別只在 source 標記，彙總時才分得出是誰回報的。
 *
 * **規劃 agent 特別需要它。** 它是唯一一次看到整批任務的角色：
 * 「兩張卡的要求彼此矛盾」只有它看得見（coder 一次只做一張，結構上看不到）。
 * 它也讀完整個 repo，最容易撞到系統性的問題。先前它一個出口都沒有，
 * 撞到只能硬把任務分完群，矛盾原封不動傳給 coder，變成合併時才炸開。
 */
export function createFrictionServer(sink: FrictionSink, log: Logger, taskId: string, source: string) {
  return createSdkMcpServer({
    name: 'friction',
    version: '1.0.0',
    tools: [
      tool(
        'report_friction',
        FRICTION_TOOL_DESCRIPTION,
        {
          kind: z.enum(FRICTION_KINDS),
          what: z.string(),
          evidence: z.string().optional(),
          suggestion: z.string().optional(),
        },
        createFrictionHandler(sink, log, taskId, source),
      ),
    ],
  });
}
