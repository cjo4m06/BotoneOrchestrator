import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { safeRelPath } from '../src/worker/git-inspect.js';

/**
 * 判斷者人就在 worktree 裡、git 歷史整份都在，但它的工具只有 Read/Glob 與瀏覽器——
 * **沒有任何能執行 git 的東西**。於是它只看得到「現在這個頁面長什麼樣」，
 * 看不到「這次改了什麼」，只好把整個頁面的毛病都報上來。
 *
 * 補的是唯讀 git 工具：判斷交給 agent，邊界由程式守住。
 * 不給 Bash 是因為判斷者不該有改東西的能力。
 */
describe('safeRelPath — git 工具的路徑防呆', () => {
  it('一般的 repo 相對路徑照過', () => {
    assert.equal(safeRelPath('src/views/SandboxView.vue'), 'src/views/SandboxView.vue');
    assert.equal(safeRelPath('  package.json  '), 'package.json');
  });

  it('跳出工作目錄的一律拒絕', () => {
    assert.equal(safeRelPath('../../etc/passwd'), undefined);
    assert.equal(safeRelPath('src/../../secret'), undefined);
    assert.equal(safeRelPath('/etc/passwd'), undefined);
  });

  it('看起來像選項的拒絕（別讓它變成 git 的旗標）', () => {
    assert.equal(safeRelPath('--upload-pack=touch /tmp/x'), undefined);
    assert.equal(safeRelPath('-c'), undefined);
  });

  it('空字串與 NUL 拒絕', () => {
    assert.equal(safeRelPath(''), undefined);
    assert.equal(safeRelPath('   '), undefined);
    // NUL 用跳脫序列寫，不要把不可見字元直接放進原始碼——
    // 這個檔案自己就因為誤植 NUL 而讓我以為「測試沒在跑」，追了半天。
    assert.equal(safeRelPath('a\u0000b'), undefined, '含 NUL 的路徑要拒絕');
    assert.equal(safeRelPath('my file.ts'), 'my file.ts', '檔名有空白是合法的，不該拒絕');
  });

  it('檔名裡剛好有兩個點不算跳脫（.. 必須是完整的一段）', () => {
    assert.equal(safeRelPath('src/foo..bar.ts'), 'src/foo..bar.ts');
    assert.equal(safeRelPath('..hidden'), '..hidden');
  });
});
