import { execa } from 'execa';
import { preferRemoteRef, type GitRunner } from '../git/base-freshness.js';

/**
 * 讀 diff 與比對路徑的工具。
 *
 * ── 這裡原本是「政策引擎」，已經整組移除 ──
 *
 * 它做的事是：比對檔案路徑，命中 `**\/migrations\/**`、`.github/workflows/**`、
 * `**\/*.rules` 之類的 glob 就判定「這個 PR 要人工核准」，其餘（純樣式/文件）自動合併。
 *
 * 兩個問題讓它不該存在：
 *
 * 1. **它在猜別人的 repo 長什麼樣。** 換一個把 migration 放在 `db/schema/`、
 *    用別的 CI、或根本沒有 `.rules` 檔的專案，就同時做錯兩件事——該擋的沒擋、
 *    不該擋的亂擋。secrets 那組更是裝飾品：只抓得到「檔名叫 .env」，
 *    而真正會發生的是「把 API key 貼進 src/config.ts」。
 *
 * 2. **它在替使用者決定風險容忍度。** 「這個改動值不值得問你」本來就是使用者的決定，
 *    不是一組寫死的規則該猜的。
 *
 * 現在的做法：一個開關（allowLocalMerge，使用者決定要不要自動合併）
 * ＋ 一個看得懂那個 repo 的判斷者（merge-risk-judge.ts，只在開關開著時攔
 * 「做錯了救不回來」的改動）。
 *
 * ── 沒有被移除的是工具層的硬邊界 ──
 *
 * evaluateToolPolicy（agent-runtime.ts）在 PreToolUse hook 直接 deny，
 * agent 根本改不到 `.env`、`.git/`、跑不了部署指令。那是**當下、單次工具呼叫**的
 * 阻擋，不是事後的判斷，也不靠提示詞。它用的 matchGlob 就在本檔。
 */

export interface PolicyInput {
  /** 本次變更涉及的所有檔案（repo 相對路徑）。 */
  files: string[];
  /** 被刪除的檔案（files 的子集）。無法取得時可省略。 */
  deleted?: string[];
  /**
   * 「刪檔清單取不到」的明示旗標（例如 git name-status 讀取失敗）。
   * 與 `deleted: []`（確定沒刪檔）語意不同：未知時必須保守轉人工，
   * 否則一個讀取失敗就會讓刪檔紅線靜默失效。
   */
  deletedUnknown?: boolean;
  additions: number;
  deletions: number;
}

export function matchGlob(path: string, pattern: string): boolean {
  let src = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') {
      // `**/` 要能匹配「零層目錄」，否則 **/x.md 對不上根目錄的 x.md
      if (pattern[i + 2] === '/') {
        src += '(?:.*/)?';
        i += 3;
      } else {
        src += '.*';
        i += 2;
      }
    } else if (c === '*') {
      src += '[^/]*';
      i += 1;
    } else if (c === '?') {
      src += '[^/]';
      i += 1;
    } else {
      src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${src}$`).test(normalize(path));
}

/**
 * 把 git 的改名表示法展開成「舊路徑 + 新路徑」兩筆。
 * git 在偵測到改名時會把兩個路徑併成**一個欄位**：
 *   `docs/notes.md => .github/workflows/deploy.yml`
 *   `src/{old => new}/a.ts`（共同前後綴會被收進大括號）
 * 若整串當成一個路徑去比對 glob，`docs/**` 這種安全規則會把整串「命中」，
 * 於是新增 CI workflow 的變更被判成可自動合併——CI 與刪檔兩條紅線同時失效。
 * 所以一律展開成兩筆各自判定；舊路徑同時視為「被刪除」。
 */
export function expandRenamePath(raw: string): { paths: string[]; from?: string; to?: string } {
  const path = raw.trim();
  const braced = /^(.*)\{(.*?) => (.*?)\}(.*)$/.exec(path);
  if (braced) {
    const [, pre = '', from = '', to = '', post = ''] = braced;
    // 大括號一邊為空時（移進/移出某層目錄）會留下多餘的斜線，收乾淨才比對得到 glob
    const join = (mid: string): string => normalize(`${pre}${mid}${post}`.replace(/\/{2,}/g, '/').replace(/^\//, ''));
    const a = join(from);
    const b = join(to);
    return { paths: uniq([a, b]), from: a, to: b };
  }
  const plain = /^(.+?) => (.+)$/.exec(path);
  if (plain) {
    const a = plain[1]!.trim();
    const b = plain[2]!.trim();
    return { paths: uniq([a, b]), from: a, to: b };
  }
  return { paths: [path] };
}

/**
 * 決定 diff 要比到哪裡。
 *
 * 'HEAD' 之類的特殊值原樣使用（那是「工作區相對 HEAD」的用途，不是分支比較）。
 * 一般分支名優先用 remote-tracking 的三點形式 `origin/<base>...`——
 * 理由見 readDiffStat 裡的說明。取不到 remote 版本就退回原本的行為。
 */
export async function resolveDiffBase(cwd: string, baseRef: string, remote = 'origin'): Promise<string> {
  if (baseRef === 'HEAD' || baseRef.includes('...') || baseRef.includes('..')) return baseRef;
  // 「該挑哪個 ref 當基準」跟崩潰對帳用的是同一套（見 preferRemoteRef 的說明）——
  // 這兩個地方各自實作過一次，也各自出過一次錯，所以收在同一個 helper 裡。
  const ref = await preferRemoteRef(gitRunner, cwd, baseRef, remote);
  return ref === baseRef ? baseRef : `${ref}...`;
}

const gitRunner: GitRunner = async (repoPath, args) => {
  const r = await execa('git', ['-C', repoPath, ...args], { reject: false });
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout, stderr: r.stderr };
};

export async function readDiffStat(cwd: string, baseRef = 'HEAD'): Promise<PolicyInput> {
  // `--no-renames`：關掉改名偵測，改名會被拆成 D 舊檔 + A 新檔，兩邊都能各自過紅線。
  // （即使某天 git 設定強制開啟改名偵測，下面的 expandRenamePath 仍會兜底展開。）
  const base = ['-C', cwd, 'diff', '--no-renames'];
  // **比較基準必須跟 Merge Guard 用的是同一個。**
  //
  // 要看的是「**這個群組改了什麼**」。用本地的 `main` 有兩個問題：
  //   1. 本地 main 常常是舊的（daemon 只 fetch origin，不會 checkout main 更新它），
  //      於是 diff 會混進「main 有但我沒有」的東西——也就是**別的群組剛合併的檔案**。
  //   2. 兩點 diff 比的是「兩邊當下的差異」，三點（`A...B`）比的才是「B 相對分岔點做了什麼」。
  //
  // 實跑撞到：一個只改 README（+95/-0）的 PR，政策判定
  // 「存在非純樣式/文件變更：useViewportWidth.js, formatTime.js, SandboxView.vue」——
  // 那三個是上一群剛合併的。結果是政策的自動合併能力被廢掉：只要 main 動過，
  // 任何群組都會看到別人的檔案而被判成需要人工核准。
  const ref = await resolveDiffBase(cwd, baseRef);
  const numstat = await execa('git', [...base, '--numstat', ref], { reject: false });
  const nameStatus = await execa('git', [...base, '--name-status', ref], { reject: false });
  if (numstat.exitCode !== 0) return { files: [], deleted: [], additions: 0, deletions: 0 };

  let additions = 0;
  let deletions = 0;
  const files: string[] = [];
  const deleted: string[] = [];
  for (const line of numstat.stdout.split('\n')) {
    // numstat 的改名格式是 `1\t2\told => new`（含 tab 對齊時路徑欄仍是第 3 欄）
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    additions += m[1] === '-' ? 0 : Number(m[1]);
    deletions += m[2] === '-' ? 0 : Number(m[2]);
    const { paths, from } = expandRenamePath(m[3]!);
    files.push(...paths);
    if (from !== undefined) deleted.push(from); // 改名 = 舊路徑消失，等同刪檔
  }

  // name-status 讀不到就不能假裝「沒刪檔」——標記未知，讓呼叫端知道這份清單不完整
  if (nameStatus.exitCode !== 0) {
    return { files: uniq(files), deleted: uniq(deleted), deletedUnknown: true, additions, deletions };
  }
  for (const line of nameStatus.stdout.split('\n')) {
    const m = /^([A-Z])(\d*)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    const status = m[1]!;
    const rest = m[3]!;
    if (status === 'D') {
      deleted.push(normalize(rest.trim()));
      continue;
    }
    // R（改名）/ C（複製）格式為 `R100\t舊\t新`；改名的舊路徑等同被刪，複製的不算
    if (status === 'R' || status === 'C') {
      const parts = rest.split('\t');
      if (parts.length >= 2) {
        const from = normalize(parts[0]!.trim());
        const to = normalize(parts[1]!.trim());
        files.push(from, to);
        if (status === 'R') deleted.push(from);
      }
    }
  }

  return { files: uniq(files), deleted: uniq(deleted), additions, deletions };
}

const normalize = (p: string): string => p.replace(/^\.\//, '');
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
