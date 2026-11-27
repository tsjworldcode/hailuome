/**
 * M8-12 · GitHub Actions 一键部署 · 动态回填 wrangler.toml
 *
 * 幂等回填指定 TOML 段（默认 [env.production]）里 D1/KV/Service binding 的真实 id。
 * 给 GitHub Actions 部署工作流与本地 bootstrap 脚本共用。
 *
 * 用法：
 *   # 单条 patch（D1 database_id / KV namespace id）
 *   node scripts/patch-wrangler-toml.mjs \
 *     --toml apps/worker-a/wrangler.toml \
 *     --binding IDENTITY_DB --id "f5f4ab3d-..."
 *
 *   # 单条 patch（Service Binding）
 *   node scripts/patch-wrangler-toml.mjs \
 *     --toml apps/worker-b/wrangler.toml \
 *     --binding WORKER_A --service "hailuo-worker-a-..."
 *
 *   # 批量 patch（JSON 文件）
 *   # JSON 格式：{ "IDENTITY_DB": "uuid", "POSTS_CACHE_KV": "32hex", ... }
 *   # 或对 Service Binding：{ "WORKER_A_SERVICE": "hailuo-worker-a-..." }
 *   node scripts/patch-wrangler-toml.mjs \
 *     --toml apps/worker-a/wrangler.toml \
 *     --json /tmp/bootstrap.json
 *
 * 选项：
 *   --section <str>   目标段，默认 [env.production]
 *   --force           即使已有真 id 也覆盖
 *   --dry-run         只打印变更，不写文件
 *   --no-backup       不备份原文件（CI 默认会备份到 <toml>.bak）
 *
 * 退出码：
 *   0 = 成功（即使全部因幂等跳过）
 *   2 = 参数错误 / 段不存在 / binding 不存在
 *   3 = 写入失败
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ── 解析命令行 ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { force: false, dryRun: false, noBackup: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--toml') args.toml = argv[++i];
    else if (a === '--section') args.section = argv[++i];
    else if (a === '--binding') args.binding = argv[++i];
    else if (a === '--id') args.id = argv[++i];
    else if (a === '--service') args.service = argv[++i];
    else if (a === '--bucket-name') args.bucketName = argv[++i];
    else if (a === '--json') args.json = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-backup') args.noBackup = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`patch-wrangler-toml.mjs — 幂等回填 wrangler.toml 的指定段

用法见文件头注释。`);
}

// ── 判断"是否真值" ──────────────────────────────────────────────────────────
// M-WORKFLOW-KV-PLACE-1：含无连字符的近零 32 hex（旧 B 占位 000…01/02/03），勿当真 KV id
const PLACEHOLDER_REGEX =
  /^(local-dev-placeholder|preview-placeholder|.*placeholder.*|00000000-0000-0000-0000-[0-9a-f]+|0{24}[0-9a-f]{8}|changeme.*)$/i;

/**
 * 判断一个值是否是"看起来像真值"的 id / service name
 * - D1 / KV namespace id：UUID v4 或 32 位 hex，且不是占位近零串
 * - Service name：以 hailuo- 开头
 */
function isLikelyReal(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (PLACEHOLDER_REGEX.test(value)) return false;
  // 额外：任意「前 24 位全 0」的 32 hex 一律占位（000…01 等）
  if (/^0{24}[0-9a-f]{8}$/i.test(value)) return false;
  // UUID 形式
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
  // 32 位 hex（KV namespace id / image_kv id 等）
  if (/^[0-9a-f]{32}$/i.test(value)) return true;
  // Worker / Pages service name
  if (/^hailuo-(worker-[ab]|web)-/i.test(value)) return true;
  return false;
}

// ── 主逻辑 ──────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));

  // 解析输入
  if (!args.toml) {
    console.error('错误：必须指定 --toml <path>');
    process.exit(2);
  }
  const tomlPath = path.isAbsolute(args.toml) ? args.toml : path.resolve(repoRoot, args.toml);
  const section = args.section || '[env.production]';

  const patches = []; // [{ binding, field, value }]
  if (args.json) {
    const jsonPath = path.isAbsolute(args.json) ? args.json : path.resolve(repoRoot, args.json);
    if (!fs.existsSync(jsonPath)) {
      console.error(`错误：JSON 文件不存在：${jsonPath}`);
      process.exit(2);
    }
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (err) {
      console.error(`错误：JSON 解析失败：${err.message}`);
      process.exit(2);
    }
    for (const [key, value] of Object.entries(obj)) {
      // 约定：xxx_SERVICE 后缀代表 service 字段（Service Binding）
      if (key.endsWith('_SERVICE')) {
        patches.push({ binding: key.slice(0, -'_SERVICE'.length), field: 'service', value });
      } else {
        // 默认 d1_databases / kv_namespaces 都用 id 字段（d1 是 database_id，需要在改写时识别）
        patches.push({ binding: key, field: null, value });
      }
    }
  } else if (args.binding && args.bucketName) {
    // M8-14：R2 bucket_name insert/update（可无既有 [[r2_buckets]]）
  } else if (args.binding && (args.id || args.service)) {
    // --id：字段名由数组项类型自动推断（d1→database_id / kv→id）
    // --service：显式写 service 字段
    patches.push({
      binding: args.binding,
      field: args.service ? 'service' : null,
      value: args.service || args.id,
    });
  } else {
    console.error(
      '错误：必须指定 --json <path> 或 (--binding + (--id | --service | --bucket-name))',
    );
    process.exit(2);
  }

  if (!fs.existsSync(tomlPath)) {
    console.error(`错误：TOML 文件不存在：${tomlPath}`);
    process.exit(2);
  }
  const original = fs.readFileSync(tomlPath, 'utf8');

  // 应用 patch
  let modified = original;
  const summary = { applied: [], skipped: [], missing: [] };

  if (args.binding && args.bucketName) {
    const result = ensureR2BucketBinding(modified, {
      section,
      binding: args.binding,
      bucketName: args.bucketName,
      force: args.force,
    });
    if (result.applied) {
      modified = result.text;
      summary.applied.push({
        binding: args.binding,
        field: 'bucket_name',
        from: result.from || '(insert)',
        to: result.to,
      });
    } else if (result.skipped) {
      summary.skipped.push({
        binding: args.binding,
        reason: result.reason,
        currentValue: result.from,
      });
    }
  }

  for (const { binding, field: fieldHint, value } of patches) {
    const result = applyPatch(modified, section, binding, value, fieldHint, args.force);
    if (result.applied) {
      modified = result.text;
      summary.applied.push({ binding, field: result.field, from: result.from, to: result.to });
    } else if (result.skipped) {
      summary.skipped.push({ binding, reason: result.reason, currentValue: result.currentValue });
    } else if (result.missing) {
      summary.missing.push({ binding, reason: result.reason });
    }
  }

  // 写回
  if (modified !== original) {
    if (args.dryRun) {
      console.log(`[dry-run] 计划修改 ${path.relative(repoRoot, tomlPath)}：${summary.applied.length} 项`);
    } else {
      if (!args.noBackup) {
        const backupPath = tomlPath + '.bak';
        fs.writeFileSync(backupPath, original, 'utf8');
        console.log(`  backup → ${path.relative(repoRoot, backupPath)}`);
      }
      try {
        fs.writeFileSync(tomlPath, modified, 'utf8');
      } catch (err) {
        console.error(`错误：写入失败：${err.message}`);
        process.exit(3);
      }
      console.log(`  ✓ 写入 ${path.relative(repoRoot, tomlPath)}（${summary.applied.length} 项）`);
    }
  }

  // 打印总结
  for (const { binding, field, from, to } of summary.applied) {
    console.log(`  apply  ${binding}  ${field}: "${from}" → "${to}"`);
  }
  for (const { binding, reason, currentValue } of summary.skipped) {
    console.log(`  skip   ${binding}  (${reason}; current="${currentValue}")`);
  }
  for (const { binding, reason } of summary.missing) {
    console.error(`  fail   ${binding}  (${reason})`);
  }

  if (summary.missing.length > 0) {
    process.exit(2);
  }
  process.exit(0);
}

/**
 * M8-14：幂等确保指定段存在 R2 binding；缺失则 insert，已有则更新 bucket_name。
 * F-14：主分支通常无 [[r2_buckets]]，由部署脚本现场写入。
 *
 * @param {string} text
 * @param {{ section?: string, binding?: string, bucketName: string, force?: boolean }} opts
 * @returns {{ text: string, applied?: boolean, inserted?: boolean, skipped?: boolean, from?: string, to?: string, reason?: string }}
 */
export function ensureR2BucketBinding(text, opts) {
  const sectionKey = String(opts.section || 'env.production').replace(/^\[|\]$/g, '').trim();
  const binding = opts.binding || 'HAILUO_IMAGE_R2';
  const bucketName = opts.bucketName;
  const force = opts.force !== false;
  if (!bucketName || typeof bucketName !== 'string') {
    return { text, skipped: true, reason: '缺少 bucketName' };
  }
  if (!sectionKey) {
    return { text, skipped: true, reason: '段名无效' };
  }

  const sectionKeyEsc = sectionKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 兼容 Windows CRLF：`]` 后允许 \r，再断言 \n 或 EOF
  const sectionExistsRe = new RegExp(
    `(?:^|\\r?\\n)[ \\t]*\\[${sectionKeyEsc}\\][ \\t]*\\r?(?=\\n|$)`,
  );
  if (!sectionExistsRe.test(text)) {
    return { text, skipped: true, reason: `段 [${sectionKey}] 不存在` };
  }

  const arrayHeaderRe = new RegExp(
    `(?:^|\\r?\\n)([ \\t]*\\[\\[${sectionKeyEsc}\\.r2_buckets\\]\\][ \\t]*\\r?)(?=\\n|$)`,
    'g',
  );
  const nextHeaderRe = /\r?\n[ \t]*\[+[^\]]+\]+/;
  /** @type {Array<{ headerStart: number, headerEnd: number, bodyStart: number, bodyEnd: number, body: string }>} */
  const r2Items = [];
  let hm;
  while ((hm = arrayHeaderRe.exec(text)) !== null) {
    // headerStart：捕获组起点（跳过 match 前导的 \n / \r\n）
    const headerStart = hm.index + hm[0].length - hm[1].length;
    const headerEnd = headerStart + hm[1].length;
    const bodyStart = headerEnd;
    const rest = text.slice(bodyStart);
    const next = nextHeaderRe.exec(rest);
    const bodyEnd = next ? bodyStart + next.index : text.length;
    r2Items.push({
      headerStart,
      headerEnd,
      bodyStart,
      bodyEnd,
      body: text.slice(bodyStart, bodyEnd),
    });
  }

  for (const item of r2Items) {
    // Windows CRLF：引号后是 \r 再 \n。若只认 \n，已有绑定会被当成不存在，再插一份同名 HAILUO_IMAGE_R2。
    const bindingMatch = /(?:^|\r?\n)[ \t]*binding[ \t]*=[ \t]*"([^"]+)"[ \t]*(?=\r?\n|$)/.exec(item.body);
    if (!bindingMatch || bindingMatch[1] !== binding) continue;
    const fieldRe = /(^|\r?\n)([ \t]*bucket_name[ \t]*=[ \t]*)"([^"]*)"([ \t]*)(?=\r?\n|$)/;
    const fieldMatch = fieldRe.exec(item.body);
    if (!fieldMatch) {
      return { text, skipped: true, reason: `binding ${binding} 缺 bucket_name` };
    }
    const current = fieldMatch[3];
    if (current === bucketName) {
      return { text, skipped: true, reason: '值未变', from: current, to: bucketName };
    }
    if (!force && current && !/placeholder/i.test(current)) {
      return { text, skipped: true, reason: '已有非占位 bucket_name', from: current };
    }
    const abs = item.bodyStart + fieldMatch.index + fieldMatch[1].length;
    const oldLen = fieldMatch[2].length + 2 + current.length + (fieldMatch[4] || '').length;
    const newLine = `${fieldMatch[2]}"${bucketName}"${fieldMatch[4] || ''}`;
    return {
      text: text.slice(0, abs) + newLine + text.slice(abs + oldLen),
      applied: true,
      from: current,
      to: bucketName,
    };
  }

  const block = [
    ``,
    `[[${sectionKey}.r2_buckets]]`,
    `binding = "${binding}"`,
    `bucket_name = "${bucketName}"`,
    ``,
  ].join('\n');

  const anyArrayRe = new RegExp(
    `(?:^|\\r?\\n)([ \\t]*\\[\\[${sectionKeyEsc}\\.(\\w+)\\]\\][ \\t]*\\r?)(?=\\n|$)`,
    'g',
  );
  let lastBodyEnd = -1;
  let am;
  while ((am = anyArrayRe.exec(text)) !== null) {
    const headerStart = am.index + am[0].length - am[1].length;
    const headerEnd = headerStart + am[1].length;
    const bodyStart = headerEnd;
    const rest = text.slice(bodyStart);
    const next = nextHeaderRe.exec(rest);
    const bodyEnd = next ? bodyStart + next.index : text.length;
    if (bodyEnd > lastBodyEnd) lastBodyEnd = bodyEnd;
  }

  if (lastBodyEnd >= 0) {
    const insertAt = lastBodyEnd;
    const needNl = insertAt > 0 && text.slice(insertAt - 1, insertAt) !== '\n' ? '\n' : '';
    return {
      text: text.slice(0, insertAt) + needNl + block + text.slice(insertAt),
      applied: true,
      inserted: true,
      to: bucketName,
    };
  }

  const sectionLineRe = new RegExp(`((?:^|\\r?\\n)[ \\t]*\\[${sectionKeyEsc}\\][ \\t]*\\r?\\n)`);
  const sm = sectionLineRe.exec(text);
  if (!sm) {
    return { text, skipped: true, reason: `找不到 [${sectionKey}] 插入点` };
  }
  const insertAt = sm.index + sm[1].length;
  return {
    text: text.slice(0, insertAt) + block + text.slice(insertAt),
    applied: true,
    inserted: true,
    to: bucketName,
  };
}

/**
 * M-WORKFLOW-AE-1：从指定 env 段剥离 `[[env.*.analytics_engine_datasets]]`。
 *
 * 背景：账号未在 Dashboard 开通 Workers Analytics Engine 时，即便 OTEL_ENABLED=false，
 * wrangler deploy 只要 toml 里带 ANALYTICS binding 就会报 API 10089。
 * 默认一键部署应剥掉 production 绑定；仅当显式 OTEL_ENABLED=true 时保留。
 *
 * @param {string} text
 * @param {{ env?: string }} [opts]
 * @returns {{ text: string, removed: number }}
 */
export function stripEnvAnalyticsEngineDatasets(text, opts = {}) {
  const envName = String(opts.env || 'production').trim() || 'production';
  const envEsc = envName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerRe = new RegExp(
    `(?:^|\\r?\\n)([ \\t]*\\[\\[env\\.${envEsc}\\.analytics_engine_datasets\\]\\][ \\t]*\\r?)(?=\\n|$)`,
    'g',
  );
  const nextHeaderRe = /\r?\n[ \t]*\[+[^\]]+\]+/;
  /** @type {Array<{ start: number, end: number }>} */
  const ranges = [];
  let hm;
  while ((hm = headerRe.exec(text)) !== null) {
    const headerStart = hm.index + hm[0].length - hm[1].length;
    const bodyStart = headerStart + hm[1].length;
    const rest = text.slice(bodyStart);
    const next = nextHeaderRe.exec(rest);
    const bodyEnd = next ? bodyStart + next.index : text.length;
    // 顺带吃掉表头前多余空行，避免留下大块空白
    let start = headerStart;
    while (start > 0 && (text[start - 1] === '\n' || text[start - 1] === '\r')) {
      start -= 1;
    }
    if (start > 0) start += 1; // 保留上一段末尾一个换行
    ranges.push({ start, end: bodyEnd });
  }
  if (ranges.length === 0) {
    return { text, removed: 0 };
  }
  let out = text;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const { start, end } = ranges[i];
    out = `${out.slice(0, start)}\n${out.slice(end)}`;
  }
  return { text: out, removed: ranges.length };
}

/**
 * DEPLOY-SB-10143：从指定 env 段剥离某个 Service Binding（`[[env.*.services]]`）。
 *
 * 用途：Worker A↔B 互指时，若对端尚未创建，先临时去掉 B→A 绑定 stub 部署 B，
 * 再部署 A（可绑 B），最后用完整 toml 部署 B。避免 Cloudflare API 10143。
 *
 * @param {string} text
 * @param {{ env?: string, binding: string }} opts
 * @returns {{ text: string, removed: number }}
 */
export function stripEnvServiceBinding(text, opts) {
  const envName = String(opts?.env || 'production').trim() || 'production';
  const binding = String(opts?.binding || '').trim();
  if (!binding) {
    return { text, removed: 0 };
  }
  const envEsc = envName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bindingEsc = binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerRe = new RegExp(
    `(?:^|\\r?\\n)([ \\t]*\\[\\[env\\.${envEsc}\\.services\\]\\][ \\t]*\\r?)(?=\\n|$)`,
    'g',
  );
  const nextHeaderRe = /\r?\n[ \t]*\[+[^\]]+\]+/;
  const bindingRe = new RegExp(
    `(?:^|\\r?\\n)[ \\t]*binding[ \\t]*=[ \\t]*"${bindingEsc}"[ \\t]*(?=\\r?\\n|$)`,
  );
  /** @type {Array<{ start: number, end: number }>} */
  const ranges = [];
  let hm;
  while ((hm = headerRe.exec(text)) !== null) {
    const headerStart = hm.index + hm[0].length - hm[1].length;
    const bodyStart = headerStart + hm[1].length;
    const rest = text.slice(bodyStart);
    const next = nextHeaderRe.exec(rest);
    const bodyEnd = next ? bodyStart + next.index : text.length;
    const body = text.slice(bodyStart, bodyEnd);
    if (!bindingRe.test(body)) continue;
    let start = headerStart;
    while (start > 0 && (text[start - 1] === '\n' || text[start - 1] === '\r')) {
      start -= 1;
    }
    if (start > 0) start += 1;
    ranges.push({ start, end: bodyEnd });
  }
  if (ranges.length === 0) {
    return { text, removed: 0 };
  }
  let out = text;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const { start, end } = ranges[i];
    out = `${out.slice(0, start)}\n${out.slice(end)}`;
  }
  return { text: out, removed: ranges.length };
}

/**
 * 在 TOML 文本中找到指定段，定位 binding 行的数组项，更新 id/database_id/service。
 *
 * @param {string} text  原始 TOML 文本
 * @param {string} section  段名（含方括号），例如 "[env.production]"
 * @param {string} binding  数组项内的 binding 字段值
 * @param {string} value   目标值（id 或 service name）
 * @param {string|null} fieldHint 字段名提示（id/database_id/service）；null 时自动判断
 * @param {boolean} force  即使已有真值也覆盖
 * @returns {{text: string, applied?: boolean, skipped?: boolean, missing?: boolean, field?: string, from?: string, to?: string, reason?: string, currentValue?: string}}
 */
function applyPatch(text, section, binding, value, fieldHint, force) {
  // section 形如 "[env.production]" 或 "env.production"；剥掉方括号得到前缀
  const sectionKey = String(section).replace(/^\[|\]$/g, '').trim(); // → env.production
  if (!sectionKey) {
    return { text, missing: true, reason: `段名无效：${section}` };
  }

  // 确认段本身存在（独占一行的 [env.production]），避免误中注释里的同名文字
  const sectionKeyEsc = sectionKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionExistsRe = new RegExp(`(?:^|\\n)[ \\t]*\\[${sectionKeyEsc}\\][ \\t]*(?=\\n|$)`);
  if (!sectionExistsRe.test(text)) {
    return { text, missing: true, reason: `段 [${sectionKey}] 不存在` };
  }

  // 在整份 TOML 里找所有 [[env.production.*]] 数组表头，再按 binding 精确匹配
  // 例：[[env.production.d1_databases]] / [[env.production.kv_namespaces]] / [[env.production.services]]
  const arrayHeaderRe = new RegExp(
    `(?:^|\\n)([ \\t]*\\[\\[${sectionKeyEsc}\\.(\\w+)\\]\\][ \\t]*)(?=\\n|$)`,
    'g',
  );
  /** @type {Array<{header: string, kind: string, headerStart: number, headerEnd: number, bodyStart: number, bodyEnd: number, body: string}>} */
  const items = [];
  let m;
  while ((m = arrayHeaderRe.exec(text)) !== null) {
    const headerLine = m[1];
    const kind = m[2]; // d1_databases | kv_namespaces | services
    // headerStart 跳过可能的前导 \n
    const headerStart = m.index + (m[0].startsWith('\n') ? 1 : 0);
    const headerEnd = headerStart + headerLine.length;
    items.push({ header: headerLine.trim(), kind, headerStart, headerEnd, bodyStart: -1, bodyEnd: -1, body: '' });
  }
  if (items.length === 0) {
    return { text, missing: true, reason: `段 [${sectionKey}] 下没有 [[${sectionKey}.*]] 数组项` };
  }

  // 每个数组项的 body 范围：从本表头行结束 → 下一张表头（任意 [xxx] / [[xxx]]）或文件结束
  const nextHeaderRe = /\n[ \t]*\[+[^\]]+\]+/;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    item.bodyStart = item.headerEnd;
    const rest = text.slice(item.bodyStart);
    const next = nextHeaderRe.exec(rest);
    item.bodyEnd = next ? item.bodyStart + next.index : text.length;
    item.body = text.slice(item.bodyStart, item.bodyEnd);
  }

  // 找 binding 匹配的数组项（同段内可能有多份同类型数组，按 binding 值区分）
  let targetItem = null;
  for (const item of items) {
    const bindingMatch = /(?:^|\n)[ \t]*binding[ \t]*=[ \t]*"([^"]+)"[ \t]*(?=\n|$)/.exec(item.body);
    if (bindingMatch && bindingMatch[1] === binding) {
      targetItem = item;
      break;
    }
  }
  if (!targetItem) {
    return { text, missing: true, reason: `binding ${binding} 在段 [${sectionKey}] 内不存在` };
  }

  // 推断字段名：d1 → database_id；kv → id；services → service；也可由 --service / --id 显式指定
  let field;
  if (fieldHint) {
    field = fieldHint;
  } else if (targetItem.kind === 'd1_databases') {
    field = 'database_id';
  } else if (targetItem.kind === 'kv_namespaces') {
    field = 'id';
  } else if (targetItem.kind === 'services') {
    field = 'service';
  } else if (/^\s*database_id\s*=/m.test(targetItem.body)) {
    field = 'database_id';
  } else if (/^\s*service\s*=/m.test(targetItem.body)) {
    field = 'service';
  } else {
    field = 'id';
  }

  // 找字段现有值（保留原行缩进）
  const fieldRe = new RegExp(`(^|\\n)([ \\t]*${field}[ \\t]*=[ \\t]*)"([^"]*)"([ \\t]*)(?=\\n|$)`);
  const fieldMatch = fieldRe.exec(targetItem.body);
  if (!fieldMatch) {
    return { text, missing: true, reason: `binding ${binding} 内找不到 ${field} 字段` };
  }
  const currentValue = fieldMatch[3];
  const indentAndKey = fieldMatch[2]; // 含缩进的 `database_id = `
  const trailingWs = fieldMatch[4] || '';
  const fieldLineStartAbs = targetItem.bodyStart + fieldMatch.index + fieldMatch[1].length;
  const oldLineLen = indentAndKey.length + 2 + currentValue.length + trailingWs.length; // 2 = 两个引号
  const newLine = `${indentAndKey}"${value}"${trailingWs}`;

  // 幂等检查
  if (currentValue === value) {
    return { text, skipped: true, reason: '值未变', currentValue };
  }
  if (!force && isLikelyReal(currentValue)) {
    return { text, skipped: true, reason: '已有真值（用 --force 覆盖）', currentValue };
  }

  // 替换
  const newText = text.slice(0, fieldLineStartAbs) + newLine + text.slice(fieldLineStartAbs + oldLineLen);

  return {
    text: newText,
    applied: true,
    field,
    from: currentValue,
    to: value,
  };
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('patch-wrangler-toml.mjs') ||
    process.argv[1].includes('patch-wrangler-toml'));
if (isDirectRun) {
  main();
}

export { applyPatch, isLikelyReal };
