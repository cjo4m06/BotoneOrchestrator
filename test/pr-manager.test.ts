import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrManager, type CommandResult, type CommandRunner } from '../src/pr/pr-manager.js';
import { createSilentLogger, createRecordingLogger } from './helpers/index.js';

interface Call {
  file: string;
  args: string[];
  cwd?: string;
}

/**
 * 假的指令執行器。整個檔案**不允許**真的執行 git/gh——PrManager 的外部動作
 * （push / pr create / pr merge）碰到真實 repo 會造成不可逆後果。
 */
function makeRunner(reply: (call: Call) => Partial<CommandResult> = () => ({})): {
  run: CommandRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: CommandRunner = async (file, args, opts) => {
    const call: Call = { file, args, cwd: opts?.cwd };
    calls.push(call);
    const r = reply(call);
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { run, calls };
}

const isPrList = (c: Call): boolean => c.file === 'gh' && c.args[1] === 'list';
const isPrCreate = (c: Call): boolean => c.file === 'gh' && c.args[1] === 'create';

const OPEN_PR_INPUT = {
  repoPath: '/wt/g1',
  repo: 'acme/web',
  branch: 'feat/g1',
  base: 'main',
  title: '標題',
  body: '內文',
};

describe('PrManager — 分支與提交', () => {
  it('ensureBranch：先切 base 再以 -B 重置群組分支', async () => {
    const r = makeRunner();
    await new PrManager(createSilentLogger(), r.run).ensureBranch('/repo', 'feat/x', 'main');

    assert.deepEqual(
      r.calls.map((c) => c.args),
      [
        ['-C', '/repo', 'checkout', 'main'],
        ['-C', '/repo', 'checkout', '-B', 'feat/x'],
      ],
    );
  });

  it('ensureBranch：git 失敗要丟出（本地步驟出錯屬致命，不可默默往下走）', async () => {
    const r = makeRunner(() => ({ exitCode: 1, stderr: 'pathspec 錯誤' }));
    await assert.rejects(
      () => new PrManager(createSilentLogger(), r.run).ensureBranch('/repo', 'feat/x', 'main'),
      /pathspec 錯誤/,
    );
  });

  it('commitAll：有 staged 變更 → 提交並回 true，且排除 node_modules', async () => {
    const r = makeRunner((c) => (c.args.includes('--cached') ? { stdout: 'src/a.ts\n' } : {}));
    const ok = await new PrManager(createSilentLogger(), r.run).commitAll('/wt', 'feat: x');

    assert.equal(ok, true);
    assert.deepEqual(r.calls[0]?.args, ['-C', '/wt', 'add', '-A', '--', '.', ':(exclude)node_modules', ':(exclude).playwright-mcp']);
    assert.deepEqual(r.calls.at(-1)?.args, ['-C', '/wt', 'commit', '-q', '-m', 'feat: x']);
  });

  it('commitAll：無 staged 變更 → 不提交、回 false 並警告', async () => {
    const r = makeRunner((c) => (c.args.includes('--cached') ? { stdout: '  \n' } : {}));
    const rec = createRecordingLogger();
    const ok = await new PrManager(rec.logger, r.run).commitAll('/wt', 'feat: x');

    assert.equal(ok, false);
    assert.equal(r.calls.some((c) => c.args.includes('commit')), false);
    assert.ok(rec.messages('warn').some((m) => m.includes('無變更可提交')));
  });
});

describe('PrManager — openPr 冪等', () => {
  it('無既有 PR → push + gh pr create，並解析 url/number（預設 draft）', async () => {
    const r = makeRunner((c) => {
      if (isPrList(c)) return { stdout: '[]' };
      if (isPrCreate(c)) return { stdout: 'https://github.com/acme/web/pull/42\n' };
      return {};
    });
    const pr = await new PrManager(createSilentLogger(), r.run).openPr(OPEN_PR_INPUT);

    assert.deepEqual(pr, { url: 'https://github.com/acme/web/pull/42', number: 42 });
    assert.deepEqual(r.calls[0]?.args, ['-C', '/wt/g1', 'push', '-u', 'origin', 'feat/g1']);
    const create = r.calls.find(isPrCreate)!;
    assert.deepEqual(create.args, [
      'pr', 'create',
      '--repo', 'acme/web',
      '--base', 'main',
      '--head', 'feat/g1',
      '--title', '標題',
      '--body', '內文',
      '--draft',
    ]);
    assert.equal(create.cwd, '/wt/g1');
  });

  it('draft:false → 不帶 --draft', async () => {
    const r = makeRunner((c) => {
      if (isPrList(c)) return { stdout: '[]' };
      if (isPrCreate(c)) return { stdout: 'https://github.com/acme/web/pull/7' };
      return {};
    });
    await new PrManager(createSilentLogger(), r.run).openPr({ ...OPEN_PR_INPUT, draft: false });

    assert.equal(r.calls.find(isPrCreate)!.args.includes('--draft'), false);
  });

  it('同分支已有開著的 PR → 直接沿用，不再 create（重跑不會失敗）', async () => {
    const r = makeRunner((c) =>
      isPrList(c) ? { stdout: '[{"number":9,"url":"https://github.com/acme/web/pull/9"}]' } : {},
    );
    const pr = await new PrManager(createSilentLogger(), r.run).openPr(OPEN_PR_INPUT);

    assert.deepEqual(pr, { url: 'https://github.com/acme/web/pull/9', number: 9 });
    assert.equal(r.calls.some(isPrCreate), false, '已有 PR 就不該再 create');
    // 仍會 push：分支上可能有新的 commit 要同步上去
    assert.deepEqual(r.calls[0]?.args, ['-C', '/wt/g1', 'push', '-u', 'origin', 'feat/g1']);
    assert.deepEqual(r.calls[1]?.args, [
      'pr', 'list', '--repo', 'acme/web', '--head', 'feat/g1', '--state', 'open', '--json', 'number,url', '--limit', '1',
    ]);
  });

  it('create 失敗但事後查得到 PR（競態）→ 沿用而非丟例外', async () => {
    let listed = 0;
    const r = makeRunner((c) => {
      if (isPrList(c)) {
        listed += 1;
        return listed === 1 ? { stdout: '[]' } : { stdout: '[{"number":5,"url":"https://x/pull/5"}]' };
      }
      if (isPrCreate(c)) return { exitCode: 1, stderr: 'a pull request for branch already exists' };
      return {};
    });
    const pr = await new PrManager(createSilentLogger(), r.run).openPr(OPEN_PR_INPUT);

    assert.deepEqual(pr, { url: 'https://x/pull/5', number: 5 });
    assert.equal(listed, 2);
  });

  it('create 失敗且查不到 PR → 丟出（含 gh 訊息）', async () => {
    const r = makeRunner((c) => {
      if (isPrList(c)) return { stdout: '[]' };
      if (isPrCreate(c)) return { exitCode: 1, stderr: 'GraphQL: 權限不足' };
      return {};
    });
    await assert.rejects(() => new PrManager(createSilentLogger(), r.run).openPr(OPEN_PR_INPUT), /權限不足/);
  });

  it('push 失敗 → 丟出，且不嘗試開 PR', async () => {
    const r = makeRunner((c) => (c.file === 'git' ? { exitCode: 128, stderr: 'remote rejected' } : {}));
    await assert.rejects(() => new PrManager(createSilentLogger(), r.run).openPr(OPEN_PR_INPUT), /remote rejected/);
    assert.equal(r.calls.some((c) => c.file === 'gh'), false);
  });

  /**
   * 實跑撞到的真事故：群組分支名是 sha1(repo|任務清單) 決定的，同一組任務永遠同名；
   * PR 合併後 GitHub 不刪來源分支。於是下一輪本地從新 base 長出分支，跟遠端那顆已合併的
   * 舊 tip 分歧，push 被拒 → 整個群組 failed。
   *
   * 下面的 stderr 是從真實事故日誌原樣抄回來的——用「我以為 git 會印什麼」造假輸入，
   * 正是這類 bug 一開始躲過測試的原因。
   */
  describe('push 被拒（遠端留有同名舊分支）', () => {
    const REJECT_STDERR = [
      'To github.com:acme/web.git',
      ' ! [rejected]        feat/g1 -> feat/g1 (non-fast-forward)',
      "error: failed to push some refs to 'github.com:acme/web.git'",
      'hint: Updates were rejected because the tip of your current branch is behind',
    ].join('\n');

    const isPush = (c: Call): boolean => c.file === 'git' && c.args[2] === 'push';
    const isDelete = (c: Call): boolean => isPush(c) && c.args.includes('--delete');

    const prListState = (c: Call): string | undefined =>
      isPrList(c) ? c.args[c.args.indexOf('--state') + 1] : undefined;

    /**
     * @param merged   遠端那顆是否已完全併入 base（ancestor 判斷）
     * @param mergedPrJson  該分支上「已合併的 PR」查詢結果（squash 合併時唯一的證據）
     */
    function runnerFor(merged: boolean, openPrJson = '[]', mergedPrJson = '[]'): ReturnType<typeof makeRunner> {
      let pushes = 0;
      return makeRunner((c) => {
        if (prListState(c) === 'merged') return { stdout: mergedPrJson };
        if (isPrList(c)) return { stdout: openPrJson };
        if (isPrCreate(c)) return { stdout: 'https://github.com/acme/web/pull/12' };
        if (isDelete(c)) return {};
        if (isPush(c)) {
          pushes += 1;
          // 第一次推被拒；刪掉遠端舊分支後的第二次應成功
          return pushes === 1 ? { exitCode: 1, stderr: REJECT_STDERR } : {};
        }
        if (c.args[2] === 'rev-parse') {
          return { stdout: c.args[3].endsWith('/main') ? 'b'.repeat(40) : 'a'.repeat(40) };
        }
        if (c.args[2] === 'merge-base') return { exitCode: merged ? 0 : 1 };
        return {};
      });
    }

    it('遠端舊分支已併入 base 且無開著的 PR → 刪除後重推，流程繼續', async () => {
      const r = runnerFor(true);
      const pr = await new PrManager(createSilentLogger(), r.run).openPr(OPEN_PR_INPUT);
      assert.equal(pr.number, 12);
      assert.equal(r.calls.filter(isDelete).length, 1, '應刪除遠端舊分支一次');
      assert.equal(r.calls.filter(isPush).filter((c) => !isDelete(c)).length, 2, '應重推一次');
    });

    it('遠端舊分支尚未併入 base → 丟出，且不刪不覆寫', async () => {
      const r = runnerFor(false);
      await assert.rejects(
        () => new PrManager(createSilentLogger(), r.run).openPr(OPEN_PR_INPUT),
        /也沒有已合併的 PR/,
      );
      assert.equal(r.calls.some(isDelete), false, '未併入就刪分支等於弄丟別人的東西');
      assert.equal(r.calls.some(isPrCreate), false);
    });

    /**
     * 群組開了 PR 之後，只要 base 有變動，重做時 Merge Guard 會 rebase（改寫歷史），
     * 接著 push 必然 non-fast-forward。這是每個開發者 rebase 後更新自己 PR 的日常。
     * 先前一律拒絕 → 任何「開了 PR 又要重做」的群組都死在這裡（實跑撞到，群組 failed）。
     *
     * 安全性靠 --force-with-lease：只有遠端還停在我們讀到的那顆 commit 時才覆寫。
     */
    it('分支上有開著的 PR → 用 force-with-lease 更新它（不刪分支、也不裸 force）', async () => {
      const r = runnerFor(true, '[{"number":7,"url":"https://github.com/acme/web/pull/7"}]');
      const pr = await new PrManager(createSilentLogger(), r.run).openPr(OPEN_PR_INPUT);

      assert.equal(pr.number, 7, '沿用既有 PR');
      assert.equal(r.calls.some(isDelete), false, '絕不刪掉還開著 PR 的分支');
      const forced = r.calls.find((c) => c.args.some((a) => a.startsWith('--force-with-lease')));
      assert.ok(forced, '應該用 force-with-lease 更新');
      assert.match(forced!.args.join(' '), /--force-with-lease=feat\/g1:a{40}/);
      assert.equal(r.calls.some((c) => c.args.includes('--force') || c.args.includes('-f')), false, '不可裸 force');
    });

    it('force-with-lease 被拒（遠端在我們讀取後又變了）→ 中止而非強制覆寫', async () => {
      let pushes = 0;
      const r = makeRunner((c) => {
        if (prListState(c) === 'merged') return { stdout: '[]' };
        if (isPrList(c)) return { stdout: '[{"number":7,"url":"https://x/pull/7"}]' };
        if (isPush(c)) {
          pushes += 1;
          return { exitCode: 1, stderr: pushes === 1 ? REJECT_STDERR : 'stale info' };
        }
        if (c.args[2] === 'rev-parse') return { stdout: 'a'.repeat(40) };
        return {};
      });
      await assert.rejects(
        () => new PrManager(createSilentLogger(), r.run).openPr(OPEN_PR_INPUT),
        /已中止而非強制覆寫/,
      );
    });

    /**
     * 只靠 `merge-base --is-ancestor` 是不夠的：預設合併方式是 squash，
     * 它把整條分支壓成 base 上的一顆新 commit，原本的 commits 一顆都不是 base 的祖先。
     * 拿真實 repo 對照才發現：PR #9 squash 合併後，祖先判斷回 false ——
     * 「已經合併掉的分支」被判成「還有未合併的內容」，復原路徑等於死的。
     */
    it('squash 合併（非祖先）但有已合併的 PR → 仍可安全刪除重推', async () => {
      const r = runnerFor(false, '[]', '[{"number":9,"url":"https://github.com/acme/web/pull/9"}]');
      const pr = await new PrManager(createSilentLogger(), r.run).openPr(OPEN_PR_INPUT);
      assert.equal(pr.number, 12);
      assert.equal(r.calls.filter(isDelete).length, 1);
    });

    it('既不是祖先、也沒有已合併的 PR → 丟出（真的可能還有人的東西沒進去）', async () => {
      const r = runnerFor(false, '[]', '[]');
      await assert.rejects(
        () => new PrManager(createSilentLogger(), r.run).openPr(OPEN_PR_INPUT),
        /也沒有已合併的 PR/,
      );
      assert.equal(r.calls.some(isDelete), false);
    });

    it('是祖先時不必再問 GitHub（省一次 API）', async () => {
      const r = runnerFor(true);
      await new PrManager(createSilentLogger(), r.run).openPr(OPEN_PR_INPUT);
      assert.equal(r.calls.some((c) => prListState(c) === 'merged'), false);
    });

    it('任何情況都不得出現 force push', async () => {
      for (const merged of [true, false]) {
        const r = runnerFor(merged);
        await new PrManager(createSilentLogger(), r.run).openPr(OPEN_PR_INPUT).catch(() => undefined);
        const forced = r.calls.filter(
          (c) => isPush(c) && c.args.some((a) => /^--force/.test(a) || a === '-f'),
        );
        assert.deepEqual(forced, [], 'force push 會蓋掉尚未合併的他人成果');
      }
    });

    it('非「被拒」類的 push 失敗照舊直接丟出，不走刪分支補救', async () => {
      const r = makeRunner((c) =>
        c.file === 'git' && c.args[2] === 'push' ? { exitCode: 128, stderr: 'Permission denied (publickey)' } : {},
      );
      await assert.rejects(
        () => new PrManager(createSilentLogger(), r.run).openPr(OPEN_PR_INPUT),
        /publickey/,
      );
      assert.equal(r.calls.some(isDelete), false);
    });
  });

  it('gh pr list 失敗（如未登入）→ 視為沒有既有 PR，仍照常建立', async () => {
    const r = makeRunner((c) => {
      if (isPrList(c)) return { exitCode: 4, stderr: 'gh auth login' };
      if (isPrCreate(c)) return { stdout: 'https://github.com/acme/web/pull/11' };
      return {};
    });
    const pr = await new PrManager(createSilentLogger(), r.run).openPr(OPEN_PR_INPUT);
    assert.equal(pr.number, 11);
  });

  it('create 輸出解析不到編號 → 退回查詢補上編號', async () => {
    let listed = 0;
    const r = makeRunner((c) => {
      if (isPrList(c)) {
        listed += 1;
        return listed === 1 ? { stdout: '[]' } : { stdout: '[{"number":13,"url":"https://x/pull/13"}]' };
      }
      if (isPrCreate(c)) return { stdout: '建立完成（沒有網址）' };
      return {};
    });
    const pr = await new PrManager(createSilentLogger(), r.run).openPr(OPEN_PR_INPUT);
    assert.deepEqual(pr, { url: 'https://x/pull/13', number: 13 });
  });

  it('gh pr list 輸出不是合法 JSON → 當作沒有既有 PR（不炸）', async () => {
    const r = makeRunner((c) => {
      if (isPrList(c)) return { stdout: '<html>proxy error</html>' };
      if (isPrCreate(c)) return { stdout: 'https://github.com/acme/web/pull/1' };
      return {};
    });
    const pr = await new PrManager(createSilentLogger(), r.run).openPr(OPEN_PR_INPUT);
    assert.equal(pr.number, 1);
  });
});

describe('PrManager — updatePr', () => {
  it('組出 gh pr edit --body，成功回 true', async () => {
    const r = makeRunner();
    const ok = await new PrManager(createSilentLogger(), r.run).updatePr({
      repo: 'acme/web', prNumber: 8, body: '新內文', cwd: '/wt/g1',
    });

    assert.equal(ok, true);
    assert.deepEqual(r.calls[0]?.args, ['pr', 'edit', '8', '--repo', 'acme/web', '--body', '新內文']);
    assert.equal(r.calls[0]?.cwd, '/wt/g1');
  });

  it('同時更新標題', async () => {
    const r = makeRunner();
    await new PrManager(createSilentLogger(), r.run).updatePr({
      repo: 'acme/web', prNumber: 8, body: 'b', title: 't',
    });
    assert.deepEqual(r.calls[0]?.args, ['pr', 'edit', '8', '--repo', 'acme/web', '--body', 'b', '--title', 't']);
  });

  it('沒有欄位可更新 → 不呼叫 gh，回 false', async () => {
    const r = makeRunner();
    const ok = await new PrManager(createSilentLogger(), r.run).updatePr({ repo: 'acme/web', prNumber: 8 });
    assert.equal(ok, false);
    assert.equal(r.calls.length, 0);
  });

  it('gh 不可用 → 回 false 並警告，不丟例外（更新內文不是關鍵路徑）', async () => {
    const r = makeRunner(() => ({ exitCode: -1, stderr: 'spawn gh ENOENT' }));
    const rec = createRecordingLogger();
    const ok = await new PrManager(rec.logger, r.run).updatePr({ repo: 'acme/web', prNumber: 8, body: 'x' });

    assert.equal(ok, false);
    assert.ok(rec.messages('warn').some((m) => m.includes('更新 PR 失敗')));
  });
});

describe('PrManager — merge（外部不可逆動作）', () => {
  it('預設 squash，並帶上 --repo 與 PR 編號', async () => {
    const r = makeRunner();
    const res = await new PrManager(createSilentLogger(), r.run).merge({
      repo: 'acme/web', prNumber: 42, approvedBy: 'reviewer:alice',
    });

    assert.equal(res.ok, true);
    assert.deepEqual(r.calls[0]?.args, ['pr', 'merge', '42', '--repo', 'acme/web', '--squash']);
  });

  it('可指定 method 與 --delete-branch', async () => {
    const r = makeRunner();
    await new PrManager(createSilentLogger(), r.run).merge({
      repo: 'acme/web', prNumber: 42, approvedBy: 'policy:auto', method: 'rebase', deleteBranch: true,
    });
    assert.deepEqual(r.calls[0]?.args, ['pr', 'merge', '42', '--repo', 'acme/web', '--rebase', '--delete-branch']);
  });

  it('未指明核准來源 → 直接拒絕，且完全不呼叫 gh（安全優先）', async () => {
    const r = makeRunner();
    const rec = createRecordingLogger();
    const res = await new PrManager(rec.logger, r.run).merge({ repo: 'acme/web', prNumber: 42, approvedBy: '  ' });

    assert.equal(res.ok, false);
    assert.match(res.detail, /approvedBy/);
    assert.equal(r.calls.length, 0, '沒有核准來源時一行指令都不該送出');
    assert.ok(rec.messages('error').some((m) => m.includes('拒絕合併')));
  });

  it('gh 合併失敗 → 回 ok:false 與訊息（不丟例外，讓上層通知人類）', async () => {
    const r = makeRunner(() => ({ exitCode: 1, stderr: 'Pull request is not mergeable' }));
    const res = await new PrManager(createSilentLogger(), r.run).merge({
      repo: 'acme/web', prNumber: 42, approvedBy: 'reviewer:bob',
    });

    assert.equal(res.ok, false);
    assert.match(res.detail, /not mergeable/);
  });
});
