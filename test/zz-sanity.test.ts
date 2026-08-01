import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 這個檔案存在的唯一目的：確認測試真的有在跑。
 *
 * 起因是我一度以為 `describe/it` 的回呼沒被執行（在裡面丟例外卻回報通過），
 * 後來發現是我自己的改檔沒生效。但「測試框架有沒有真的執行斷言」這件事
 * 值得有一個常駐的證明——因為它一旦壞掉，整套測試會安靜地全綠。
 */
describe('測試框架 sanity', () => {
  it('describe/it 的回呼真的會執行斷言', () => {
    let ran = false;
    ran = true;
    assert.equal(ran, true);
    assert.throws(() => assert.equal(1, 2), /strictly equal/, 'assert.equal 必須是嚴格比較');
  });

  it('assert.equal 是嚴格比較（不是 ==）', () => {
    assert.throws(() => assert.equal('1', 1));
    assert.throws(() => assert.equal('a b', undefined));
  });
});

test('頂層 test() 一樣會執行', () => {
  assert.throws(() => assert.equal(0, false));
});
