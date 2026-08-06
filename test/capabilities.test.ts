import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ROLE_CAPABILITIES,
  CAPABILITY_TOOLS,
  toolsFor,
  serversFor,
  hasCapability,
  type AgentRole,
  type Capability,
} from '../src/worker/capabilities.js';
import { DOCS_TOOLS } from '../src/worker/docs-server.js';
import { ALLOWED_TOOLS, BROWSER_TOOLS, READONLY_BROWSER_TOOLS } from '../src/worker/agent-runtime.js';

/**
 * 「誰拿得到什麼能力」的單一清單。
 *
 * ── 這組測試在守什麼 ──
 *
 * 這個 repo 被同一種病咬過六次：能力做好了、某個建構點的清單漏一項，
 * 症狀只有一行 WARN 而閘門照樣綠燈。前五次是事後才發現的；
 * 第六次（審查者的瀏覽器與 git server 從來沒被掛上）是**這份清單建好的當下**
 * 立刻掉出來的——那正是它存在的理由。
 *
 * 所以這裡守的不是「某個角色有沒有某個工具」（那會退化成一條一條補的清單），
 * 而是**結構性質**：只有一份清單、每個角色都在上面、宣告了就一定接得上。
 */

const ROLES = Object.keys(ROLE_CAPABILITIES) as AgentRole[];

/** 各角色的實作檔——加角色時這裡也要加，否則下面的「沒有人手寫清單」驗不到它。 */
const ROLE_FILES: Record<AgentRole, string> = {
  coder: 'src/worker/agent-runtime.ts',
  reviewer: 'src/worker/reviewer.ts',
  planner: 'src/core/plan-agent.ts',
  drift_judge: 'src/pr/drift-judge.ts',
  risk_judge: 'src/core/merge-risk-judge.ts',
};

describe('清單本身', () => {
  it('五個角色都在表上（Record 是窮舉的——加角色沒填會 typecheck 失敗）', () => {
    assert.deepEqual(ROLES.sort(), ['coder', 'drift_judge', 'planner', 'reviewer', 'risk_judge']);
  });

  it('每個角色都拿得到基本的讀檔與搜尋（連查都不能查的角色沒有意義）', () => {
    for (const role of ROLES) {
      const t = toolsFor(role);
      for (const base of ['Read', 'Glob', 'Grep']) {
        assert.ok(t.includes(base), `${role} 少了 ${base}`);
      }
    }
  });

  it('**每個角色都要有 docs**——「規格逐條 vs diff」是它們共同的工作', () => {
    for (const role of ROLES) {
      assert.ok(
        hasCapability(role, 'docs'),
        `${role} 沒有 docs 能力。程式預抓規格有兩個無聲的失效模式（docRef 字串對不上、`
        + `規格在任務進行中被更新），兩個都實際發生過——每個角色都要自己去查`,
      );
      for (const t of DOCS_TOOLS) assert.ok(toolsFor(role).includes(t), `${role} 少了 ${t}`);
    }
  });

  it('要查證的角色都必須有 Bash（它們跑在 readonly policy 底下，只能執行查詢類指令）', () => {
    for (const role of ROLES) {
      assert.ok(
        toolsFor(role).includes('Bash'),
        `${role} 少了 Bash——它的職責就是去查證，沒有 Bash 等於瞎了。`
        + '實跑撞過：把 allowTools 改成強制之後，少列等於默默拿掉它一直在用的能力',
      );
    }
  });

  it('**只有寫程式的 agent 能改檔案**（審查者順手把問題改掉就失去審查意義）', () => {
    for (const role of ROLES) {
      assert.equal(hasCapability(role, 'edit'), role === 'coder', `${role} 的寫入權限不對`);
    }
  });

  it('唯讀角色不得拿到完整瀏覽器（差別是 file_upload）', () => {
    assert.equal(hasCapability('reviewer', 'browser_full'), false);
    assert.ok(hasCapability('reviewer', 'browser_readonly'));
    assert.ok(
      !READONLY_BROWSER_TOOLS.includes('mcp__playwright__browser_file_upload'),
      '唯讀清單本身就不該有 file_upload',
    );
  });

  it('規劃者要有 friction（它是唯一看得到「兩張卡彼此矛盾」的角色）', () => {
    assert.ok(
      hasCapability('planner', 'friction'),
      'coder 一次只做一張卡，結構上看不到跨卡的矛盾；沒有出口的話它只能硬分完群，'
      + '矛盾原封不動傳給 coder，變成合併時才炸開',
    );
  });
});

describe('沒有人再手寫自己的清單', () => {
  /**
   * **這是這整份機制的核心保證。**
   *
   * 前六次事故的形狀完全一樣：能力是一份，接線是五份，某個建構點手寫的陣列漏了一項。
   * 只要還有人手寫，加能力就還是要記得改五個地方——而「記得」正是失敗過六次的東西。
   */
  it('五個角色的工具清單都來自 toolsFor，沒有人自己拼陣列', () => {
    for (const role of ROLES) {
      const src = readFileSync(ROLE_FILES[role], 'utf8');
      assert.match(
        src,
        /toolsFor\(/,
        `${ROLE_FILES[role]} 沒有用 toolsFor——手寫清單就是這個 repo 壞過六次的地方`,
      );
    }
  });

  it('五個角色的 mcpServers 都來自 serversFor，沒有人自己組物件', () => {
    for (const role of ROLES) {
      const src = readFileSync(ROLE_FILES[role], 'utf8');
      assert.match(src, /serversFor\(/, `${ROLE_FILES[role]} 沒有用 serversFor`);
      // 手寫 `mcpServers: { docs: ... }` 這種形狀要絕跡
      assert.doesNotMatch(
        src,
        /mcpServers:\s*\{\s*\w+\s*:/,
        `${ROLE_FILES[role]} 還在手寫 mcpServers 物件——那就是漏掉一個 server 也不會有人知道的地方`,
      );
    }
  });

  it('寫程式的 agent 的 ALLOWED_TOOLS 就是表算出來的（不是另一份手抄）', () => {
    assert.deepEqual(ALLOWED_TOOLS, toolsFor('coder', { full: BROWSER_TOOLS }));
  });
});

/**
 * **main 有沒有把每個角色宣告的材料真的注入。**
 *
 * 表管得到「誰該有什麼」，管不到「有沒有人給」——那一段在 main 的建構點上，
 * 而那正是第 6 次事故的位置（審查者宣告了瀏覽器，main 沒給，於是它叫不動）。
 *
 * 這裡的清單**從 ROLE_CAPABILITIES 推導**，不是手抄：加一個需要材料的能力，
 * 沒補 main 的注入就會在這裡紅，不必記得回來加測試。
 */
describe('main 的材料注入', () => {
  /** 需要 main 注入材料的能力 → 建構點附近該出現的識別字。 */
  const NEEDS: Partial<Record<Capability, RegExp>> = {
    docs: /docs:/,
    friction: /frictionSink/,
    browser_full: /browserOutputRoot/,
    browser_readonly: /browserOutputRoot/,
  };
  /** 各角色在 main 的建構點。git 與 ask 由角色自己就地建，不需要 main 給。 */
  const CTOR: Record<AgentRole, string> = {
    coder: 'new AgentRuntime(',
    reviewer: 'new Reviewer({',
    planner: 'new PlanAgent({',
    drift_judge: 'new DriftJudge({',
    risk_judge: 'new MergeRiskJudge({',
  };

  const main = readFileSync('src/main.ts', 'utf8');

  for (const role of ROLES) {
    it(`${role} 宣告的每一項能力，main 都給了材料`, () => {
      const i = main.indexOf(CTOR[role]);
      assert.ok(i >= 0, `main 裡找不到 ${CTOR[role]}`);
      const block = main.slice(i, i + 900);
      for (const cap of ROLE_CAPABILITIES[role]) {
        const need = NEEDS[cap];
        if (!need) continue; // 這項能力不需要 main 注入
        assert.match(
          block,
          need,
          `${role} 宣告了 ${cap}，但 main 的建構點沒有注入它的材料——`
          + '工具名會在 allowedTools 裡，agent 呼叫時才失敗，而那時只剩一行 WARN',
        );
      }
    });
  }
});

describe('serversFor：宣告了能力卻沒材料，要講得出自己少了什麼', () => {
  it('材料齊全 → 全部掛上，missing 是空的', () => {
    const r = serversFor('reviewer', { docs: () => 'D', git: () => 'G', browser: () => 'B' });
    assert.deepEqual(Object.keys(r.servers).sort(), ['docs', 'git', 'playwright']);
    assert.deepEqual(r.missing, []);
  });

  it('**宣告了但沒給材料 → 列進 missing**（這一格就是前六次事故的瞬間）', () => {
    const r = serversFor('reviewer', { docs: () => 'D' });

    assert.deepEqual(
      r.missing.sort(),
      ['browser_readonly', 'git_readonly'],
      '工具名在 allowedTools 裡、server 卻沒掛——agent 呼叫時才失敗，而那時只剩一行 WARN。'
      + '審查者的瀏覽器與 git 就是這樣失蹤的（第 12 片列了工具，runQuery 只掛 docs）',
    );
  });

  it('沒宣告的能力不會被掛上，就算材料給了也一樣', () => {
    const r = serversFor('drift_judge', { docs: () => 'D', git: () => 'G', browser: () => 'B', ask: () => 'A' });
    assert.deepEqual(Object.keys(r.servers).sort(), ['docs', 'git'], '飄移判斷者要自己查 diff，但不需要瀏覽器也不需要出口工具');
    assert.deepEqual(r.missing, []);
  });

  it('工廠函式只在角色宣告了該能力時才被呼叫（建 server 可能開行程／花錢）', () => {
    let built = 0;
    serversFor('drift_judge', { browser: () => { built += 1; return 'B'; } });  // 它沒宣告 browser
    assert.equal(built, 0);
  });
});

describe('加一個能力只要改一處', () => {
  it('CAPABILITY_TOOLS 改了，所有宣告該能力的角色自動拿到', () => {
    // docs 是最多角色共用的能力——它的工具全部都要出現在每個宣告者身上
    const holders = ROLES.filter((r) => hasCapability(r, 'docs'));
    assert.ok(holders.length >= 4, '前提：docs 是共用能力');
    for (const role of holders) {
      for (const t of CAPABILITY_TOOLS.docs) {
        assert.ok(toolsFor(role).includes(t), `${role} 沒有自動拿到 ${t}`);
      }
    }
  });

  it('每一項能力都有對應的工具或 server（空殼能力會讓宣告變成空話）', () => {
    const serverBacked: Capability[] = ['browser_full', 'browser_readonly'];
    for (const [cap, tools] of Object.entries(CAPABILITY_TOOLS) as [Capability, readonly string[]][]) {
      if (serverBacked.includes(cap)) continue; // 這兩個的清單由呼叫端注入，見 capabilities.ts 的說明
      assert.ok(tools.length > 0, `能力 ${cap} 沒有任何工具`);
    }
  });
});
