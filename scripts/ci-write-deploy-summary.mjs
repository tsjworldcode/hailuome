/**
 * M-WORKFLOW-SUMMARY-1 · 写 GitHub Actions 部署摘要（纯 Node，避开 bash 反引号坑）
 *
 * 旧 inline `node -e "...\`已绑定...\`"` 会被 bash 当命令替换 → `已绑定: command not found`
 * 再导致 ternary 变成 `otel_enabled?:` → SyntaxError。
 *
 * 用法：
 *   node scripts/ci-write-deploy-summary.mjs
 *   CI_DEPLOY_STATE_PATH=... GITHUB_STEP_SUMMARY=... node scripts/ci-write-deploy-summary.mjs
 *
 * 无 state：打印提示并以 exit 0 结束（summary job 用 if: always()，不阻断）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const statePath =
  process.env.CI_DEPLOY_STATE_PATH ||
  path.join(repoRoot, 'scripts', '.ci-deploy-state.json');

function analyticsLabel(analytics) {
  const a = analytics && typeof analytics === 'object' ? analytics : {};
  if (a.stripped) return '已剥离（OTEL 关，避免 10089）';
  if (a.otel_enabled) return '已绑定 ANALYTICS（OTEL 开）';
  return '未绑定 / 默认关';
}

function buildMarkdown(state) {
  const handle = state.BOOTSTRAP_HANDLE || '';
  const bUrl = state.urls?.worker_b_url || '';
  const pUrl = state.urls?.pages_url || '';
  const bName = state.WORKER_B_NAME || '';
  const pName = state.PAGES_PROJECT_NAME || '';
  const ae = analyticsLabel(state.analytics);
  // 身份派生自检：组码/资源名/handle 由 Cloudflare 账号 + 槽位确定性派生，不是每次随机。
  // 换账号或槽位时，这一行能直接解释「为什么资源名全变了」。
  const groupCode = state.DEPLOY_GROUP_CODE || '';
  const slot = state.HAILUO_NODE_SLOT || '1';
  const identityNote = groupCode
    ? `组码 \`${groupCode}\` = sha256(Cloudflare 账号 + 槽位 ${slot}) 前 6 位；同账号同槽位稳定复用，非随机`
    : '未知（state 缺组码；若持续出现请检查 bootstrap 产物）';

  return [
    '## 海螺节点部署摘要',
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 占位 handle | \`${handle}\` |`,
    `| 身份派生 | ${identityNote} |`,
    `| Worker B（公开读） | ${bUrl} |`,
    `| Pages（站主 Web） | ${pUrl} |`,
    `| Worker B 名 | \`${bName}\` |`,
    `| Pages 项目 | \`${pName}\` |`,
    `| Analytics Engine | ${ae} |`,
    '',
    '> Worker A 地址**不在此显示**（私密写层）。站主写层经 Pages Owner Gateway → Service Binding。',
    '> 换 Cloudflare 账号或 `HAILUO_NODE_SLOT` 才会换组码 / 资源名；同账号同槽位重复部署只复用，不重复建库。',
    '',
    '### 下一步',
    '1. 打开 Pages 地址 → 登录（首次通常 `admin` / `admin`，随后强制改密）',
    '2. 在设置里完成注册中心登记',
    '3. 可选：`npm run smoke:remote` 验证（本机设 WORKER_B_URL）',
    '',
  ].join('\n');
}

function main() {
  if (!fs.existsSync(statePath)) {
    const tip = [
      '❌ Bootstrap 阶段失败，无法生成摘要',
      '请检查上方 job 日志，或确认 CLOUDFLARE_API_TOKEN 权限（需 Edit Cloudflare Workers + D1 + KV + Pages）',
      '若 Deploy Workers 失败：常见是缺 CLOUDFLARE_ACCOUNT_ID → wrangler /memberships 10000',
      '',
    ].join('\n');
    console.log(tip);
    const out = process.env.GITHUB_STEP_SUMMARY;
    if (out) {
      try {
        fs.appendFileSync(out, tip, 'utf8');
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (err) {
    console.error(`解析 state 失败：${err?.message || err}`);
    process.exit(1);
  }

  const md = buildMarkdown(state);
  // 额外落盘：便于 upload-artifact，站主可在 Actions 产物里反复下载（不依赖 Summary 页是否还开着）
  const fileOut =
    process.env.CI_DEPLOY_SUMMARY_PATH ||
    path.join(repoRoot, 'scripts', 'ci-deploy-summary.md');
  try {
    fs.mkdirSync(path.dirname(fileOut), { recursive: true });
    fs.writeFileSync(fileOut, md, 'utf8');
    console.log(`已写入文件 ${path.relative(repoRoot, fileOut)}`);
  } catch (err) {
    console.warn(`写 summary 文件失败（继续）：${err?.message || err}`);
  }
  const out = process.env.GITHUB_STEP_SUMMARY;
  if (out) {
    fs.appendFileSync(out, md, 'utf8');
    console.log('已写入 GITHUB_STEP_SUMMARY');
  } else if (!process.env.CI_DEPLOY_SUMMARY_PATH) {
    process.stdout.write(md);
  }
}

export { analyticsLabel, buildMarkdown };

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
