#!/usr/bin/env node
/**
 * MIGRATION-COVERAGE：代码引用的表/列必须出现在「该 binding 对应 migrations 目录」的 DDL 里。
 *
 * 背景（2026-11-26 真机）：M-OPT-SPLIT 拆三库时，`urlChangeLocalReconcile` 的代码切到了
 * `resolveIdentityDb`，但建表只留在 GOVERNANCE / DB_IMPORT 目录；`url_change_notify_jobs`
 * 的 `lease_until` 也在拆库时漏掉 ALTER —— 两者都不会被 TypeScript 或静态字符串测试发现，
 * 线上只在 Cron 里静默报 `no such table` / `no such column`。
 *
 * 检查范围（保守、可解释）：
 * - 只查 IDENTITY_DB / GOVERNANCE_DB / CONTENT_DB 三个显式 resolver 的库。
 *   MESSAGING / MESSAGING_SHARD 走 `env.MESSAGING_DB` 与动态分片路由，静态归属不确定，暂不纳入。
 * - 表名：INSERT INTO / UPDATE / DELETE FROM / FROM / JOIN 后的字面表名。
 * - 列名：INSERT 列清单、UPDATE ... SET 的列、以及「简单列清单」的 SELECT。
 *   含函数、`*`、子查询、模板插值的语句跳过列检查（只做表检查），避免误报。
 * - DDL 来源：`CREATE TABLE [IF NOT EXISTS]`、`ALTER TABLE ... ADD [COLUMN]`。
 *
 * 用法：
 *   node scripts/check-migration-coverage.mjs
 *   node scripts/check-migration-coverage.mjs --report     # 打印每个库的解析统计
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const BINDINGS = [
  { id: 'identity', resolver: 'resolveIdentityDb', dir: 'apps/worker-a/db/migrations-identity' },
  { id: 'governance', resolver: 'resolveGovernanceDb', dir: 'apps/worker-a/db/migrations-governance' },
  { id: 'content', resolver: 'resolveContentDb', dir: 'apps/worker-a/db/migrations-content' },
  // messaging 走 `messagingDb(env)` 帮助函数；分片库（messaging-shard-migrations）与主库同 schema，
  // 这里只核对主库 DDL，避免同一张表在两边重复报。
  { id: 'messaging', resolver: 'messagingDb', dir: 'apps/worker-a/db/messaging-migrations' },
];

/** `env.MESSAGING_DB.prepare(` 这类直连写法（不经 resolve/messagingDb 帮助函数） */
const INLINE_BINDINGS = [{ id: 'messaging', pattern: /env\.MESSAGING_DB\b/ }];

const SKIP_TABLES = new Set(['sqlite_sequence', 'sqlite_master', 'd1_migrations']);
const SKIP_COLUMNS = new Set(['rowid', 'oid', '_rowid_']);

/** 去掉 SQL 里的 -- 行注释与 /* *\/ 块注释，避免注释正文被当成列名/表名 */
function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/** 解析 CREATE TABLE 的列定义：返回列名集合 */
function parseCreateTableColumns(body) {
  const cols = new Set();
  let depth = 0;
  let start = 0;
  const parts = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const first = (part.match(/^([A-Za-z_][A-Za-z0-9_]*)/) ?? [])[1];
    if (!first) continue;
    if (/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/i.test(first)) continue;
    cols.add(first.toLowerCase());
  }
  return cols;
}

/** 依次读取 dir 下所有 .sql，建立 table -> columns 映射 */
function loadDdl(relDir) {
  const dir = join(root, relDir);
  const tables = new Map(); // table -> Set(columns)
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const sqlRaw = readFileSync(join(dir, f), 'utf8');
    const sql = stripSqlComments(sqlRaw);
    const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s*\(/gi;
    let m;
    while ((m = createRe.exec(sql))) {
      const table = m[1].toLowerCase();
      const open = createRe.lastIndex - 1;
      let depth = 0;
      let end = open;
      for (let i = open; i < sql.length; i += 1) {
        if (sql[i] === '(') depth += 1;
        else if (sql[i] === ')') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const body = sql.slice(open + 1, end);
      const cols = tables.get(table) ?? new Set();
      for (const c of parseCreateTableColumns(body)) cols.add(c);
      tables.set(table, cols);
    }
    const alterRe =
      /alter\s+table\s+([a-z_][a-z0-9_]*)\s+add\s+(?:column\s+)?([a-z_][a-z0-9_]*)/gi;
    while ((m = alterRe.exec(sql))) {
      const table = m[1].toLowerCase();
      const cols = tables.get(table) ?? new Set();
      cols.add(m[2].toLowerCase());
      tables.set(table, cols);
    }
  }
  return tables;
}

function walkTs(relDir, out = []) {
  const dir = join(root, relDir);
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walkTs(relative(root, abs).replace(/\\/g, '/'), out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

const TABLE_REF_RE =
  /(?:\binsert\s+(?:or\s+[a-z]+\s+)?into|\bupdate|\bdelete\s+from|\bfrom|\bjoin)\s+([a-z_][a-z0-9_]*)/gi;

/** 从一段 SQL 里抽出表引用；跳过明显非表的标识（子查询别名、关键字） */
function extractTableRefs(sql) {
  const refs = new Map(); // table -> [{ start, end }]
  let m;
  TABLE_REF_RE.lastIndex = 0;
  while ((m = TABLE_REF_RE.exec(sql))) {
    const table = m[1].toLowerCase();
    if (SKIP_TABLES.has(table)) continue;
    if (/^(select|where|set|values|into|table|index|if|exists|on|as|and|or|not)$/i.test(table)) continue;
    // FROM (SELECT ...) / JOIN ( ... ) 这种情况正则不会命中，已天然跳过
    const start = m.index + m[0].length - m[1].length;
    const list = refs.get(table) ?? [];
    list.push({ start, end: start + m[1].length });
    refs.set(table, list);
  }
  return refs;
}

/** INSERT 列清单 */
function extractInsertColumns(sql, table) {
  const re = new RegExp(
    `insert\\s+(?:or\\s+[a-z]+\\s+)?into\\s+${table}\\s*\\(([^)]*)\\)`,
    'gi',
  );
  const m = re.exec(sql);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z_][a-z0-9_]*$/.test(s));
}

/** UPDATE ... SET 的列 */
function extractUpdateColumns(sql, table) {
  const re = new RegExp(
    `update\\s+${table}\\s+set\\s+([^;]*?)(?:\\bwhere\\b|$)`,
    'i',
  );
  const m = re.exec(sql);
  if (!m) return null;
  const cols = [];
  for (const seg of m[1].split(',')) {
    const name = (seg.match(/^\s*([a-z_][a-z0-9_]*)\s*=/i) ?? [])[1];
    if (name) cols.push(name.toLowerCase());
  }
  return cols.length > 0 ? cols : null;
}

/** 单表 SELECT 的别名（FROM t [AS] x；无别名或关键字当作无） */
function extractTableAlias(sql, table) {
  const re = new RegExp(`\\bfrom\\s+${table}\\b\\s*(?:as\\s+)?([a-z_][a-z0-9_]*)?`, 'i');
  const m = re.exec(sql);
  const alias = (m?.[1] ?? '').toLowerCase();
  if (
    !alias ||
    /^(where|group|order|limit|having|on|join|left|right|inner|outer|union|offset|window)$/.test(alias)
  ) {
    return null;
  }
  return alias === table ? null : alias;
}

/** 简单 SELECT 列清单：裸 ident 或「表名/别名.col」才返回；其它（函数、*、未知别名）跳过列检查 */
function extractSelectColumns(sql, table) {
  const alias = extractTableAlias(sql, table);
  const re = new RegExp(`select\\s+([^;]*?)\\s+from\\s+${table}\\b`, 'i');
  const m = re.exec(sql);
  if (!m) return null;
  const seg = m[1].trim();
  if (!seg || seg === '*' || /[()*]/.test(seg) || /\bas\b/i.test(seg)) return null;
  const cols = [];
  for (const part of seg.split(',')) {
    const token = part.trim();
    const simple = token.match(/^(?:([a-z_][a-z0-9_]*)\.)?([a-z_][a-z0-9_]*)$/i);
    if (!simple) return null;
    const prefix = simple[1]?.toLowerCase();
    if (prefix && prefix !== table && prefix !== alias) return null;
    const name = simple[2].toLowerCase();
    if (name === table) continue;
    if (/^\d+$/.test(name)) continue;
    cols.push(name);
  }
  return cols;
}

/** 单表语句里 LENGTH()/COALESCE()/SUM() 等函数的裸列参数（聚合表达式里的列引用，最易漏检） */
function extractFunctionArgColumns(sql) {
  const cols = new Set();
  // 只看「函数第一个参数是裸列」的形态；`fr.col` 这类别名限定跳过（列归属由 SELECT 分支处理）
  const re = /\b(?:LENGTH|COALESCE|SUM|MAX|MIN|AVG)\s*\(\s*([a-z_][a-z0-9_]*)\b(?!\s*\.)/gi;
  let m;
  while ((m = re.exec(sql))) {
    const name = m[1].toLowerCase();
    if (
      /^(select|from|where|and|or|not|case|when|then|else|end|null|count|sum|length|coalesce|max|min|avg|nullif|trim|ltrim|rtrim|lower|upper|json_extract|cast|date|datetime|strftime|abs|round)$/.test(
        name,
      )
    ) {
      continue;
    }
    cols.add(name);
  }
  return [...cols];
}

/** 处理一条 SQL：返回 { tables, missingTables, missingColumns } */
function analyzeSql(sql, ddl, bindingLabel, file) {
  const missingTables = [];
  const missingColumns = [];
  const refs = extractTableRefs(sql);
  // 有 JOIN 时列归属无法静态判定（`s.sync_tier` 属于 join 的另一张表），只做表检查；
  // 单表语句连 `t.col` 一起校验（t 必须是表名或 FROM 别名，见 extractSelectColumns）。
  const skipColumnCheck = /\bjoin\b/i.test(sql);
  for (const [table, positions] of refs) {
    if (!ddl.has(table)) {
      missingTables.push({ table, bindingLabel, file });
      continue; // 表都不在，列检查没有意义
    }
    if (skipColumnCheck) continue;
    const known = ddl.get(table);
    const used = new Set();
    // 单表语句才检查聚合函数参数里的列（多表/别名无法归属）
    if (refs.size === 1) {
      for (const c of extractFunctionArgColumns(sql)) {
        // LENGTH(...) 里的字符串常量、COALESCE(x, '') 的第二参数等由词法形态过滤
        used.add(c);
      }
    }
    for (const cols of [
      extractInsertColumns(sql, table),
      extractUpdateColumns(sql, table),
      extractSelectColumns(sql, table),
    ]) {
      if (!cols) continue;
      for (const c of cols) used.add(c);
    }
    for (const col of used) {
      if (SKIP_COLUMNS.has(col)) continue;
      if (known.has(col)) continue;
      // 允许 UPDATE SET 右侧用 excluded.x / 别名前缀
      if (col.startsWith('excluded')) continue;
      missingColumns.push({ table, column: col, bindingLabel, file });
    }
    void positions;
  }
  return { missingTables, missingColumns };
}

/**
 * 自检：用合成 DDL 验证「表/列/别名」三条判定真的会报错，避免规则被改坏后静默变松。
 */
function runSelfTest() {
  const ddl = new Map([['demo', new Set(['id', 'name'])]]);
  const cases = [
    { sql: 'SELECT missing FROM demo', expectViolation: 'missing' },
    { sql: 'SELECT d.missing FROM demo d', expectViolation: 'missing' },
    { sql: 'SELECT d.name FROM demo d', expectViolation: null },
    { sql: 'SELECT x.name FROM demo d', expectViolation: null }, // 未知别名 → 跳过列检查
    { sql: 'SELECT LENGTH(nope) FROM demo', expectViolation: 'nope' },
    { sql: 'SELECT * FROM absent_table', expectViolation: 'absent_table' },
  ];
  for (const c of cases) {
    const r = analyzeSql(c.sql, ddl, 'selftest', 'selftest');
    const got = r.missingColumns[0]?.column ?? r.missingTables[0]?.table ?? null;
    if (got !== c.expectViolation) {
      console.error(`MIGRATION-COVERAGE 自检失败：${c.sql} 期望 ${c.expectViolation} 实际 ${got}`);
      process.exitCode = 1;
      return false;
    }
  }
  return true;
}

function main() {
  const report = process.argv.includes('--report');
  if (!runSelfTest()) return;
  const ddlByBinding = new Map();
  for (const b of BINDINGS) {
    ddlByBinding.set(b.id, loadDdl(b.dir));
  }

  // 防漂移：wrangler.toml 的 migrations_dir 必须仍指向我们检查的目录，
  // 否则门禁会在「检查旧目录」的假绿状态下运行。
  const toml = readFileSync(join(root, 'apps/worker-a/wrangler.toml'), 'utf8');
  const declaredDirs = new Set(
    [...toml.matchAll(/migrations_dir\s*=\s*"([^"]+)"/g)].map((m) => m[1]),
  );
  for (const b of BINDINGS) {
    const rel = b.dir.replace(/^apps\/worker-a\//, '');
    if (!declaredDirs.has(rel)) {
      console.error(`MIGRATION-COVERAGE：wrangler.toml 未声明 migrations_dir="${rel}"（${b.id}）`);
      process.exitCode = 1;
      return;
    }
  }

  const files = walkTs('apps/worker-a/src');
  const violations = [];
  let sqlCount = 0;

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const relFile = relative(root, file).replace(/\\/g, '/');

    // 1) 收集本文件的 resolver 声明（const identityDb = resolveIdentityDb(env) 等）
    const decls = [];
    for (const b of BINDINGS) {
      const declRe = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*${b.resolver}\\(`, 'g');
      let dm;
      while ((dm = declRe.exec(src))) {
        decls.push({ index: dm.index, varName: dm[1], binding: b.id });
      }
    }
    if (decls.length === 0) continue;
    decls.sort((a, b) => a.index - b.index);

    // 2) 找出所有 `xxx.prepare(\`...\`)` / `xxx.batch([...` 用法，按「最近的同名声明」归属
    //    （同名变量在不同函数里复用很常见，就近归属比「声明后窗口」准确）
    const usageRe = /\b(\w+)\s*\.(?:prepare|batch)\(\s*`/g;
    let um;
    while ((um = usageRe.exec(src))) {
      const varName = um[1];
      let owner = null;
      for (const d of decls) {
        if (d.index >= um.index) break;
        if (d.varName === varName) owner = d;
      }
      if (!owner) continue;
      const sqlStart = um.index + um[0].length;
      const sqlEnd = src.indexOf('`', sqlStart);
      if (sqlEnd < 0) continue;
      sqlCount += 1;
      const result = analyzeSql(
        stripSqlComments(src.slice(sqlStart, sqlEnd)),
        ddlByBinding.get(owner.binding),
        owner.binding,
        relFile,
      );
      violations.push(...result.missingTables, ...result.missingColumns);
    }

    // 3) 内联写法：`await resolveIdentityDb(env).prepare(` / `(await resolveContentDb(env)).batch(`
    //    （没有变量声明，避免成为检查盲区 —— lookupAssist 的额度写入就属于这一种）
    const inlineRe = /\bresolve(Identity|Governance|Content)Db\(\s*env\s*\)/g;
    let im;
    while ((im = inlineRe.exec(src))) {
      const binding = im[1].toLowerCase();
      const lookahead = src.slice(im.index + im[0].length, im.index + im[0].length + 40);
      const m2 = lookahead.match(/^\s*\)?\s*\.\s*(?:prepare|batch)\(\s*`/);
      if (!m2) continue;
      const sqlStart = im.index + im[0].length + m2[0].length;
      const sqlEnd = src.indexOf('`', sqlStart);
      if (sqlEnd < 0) continue;
      sqlCount += 1;
      const result = analyzeSql(
        stripSqlComments(src.slice(sqlStart, sqlEnd)),
        ddlByBinding.get(binding),
        binding,
        relFile,
      );
      violations.push(...result.missingTables, ...result.missingColumns);
    }

    // 3b) env.MESSAGING_DB.prepare(`...`) 直连写法
    for (const inline of INLINE_BINDINGS) {
      const re = new RegExp(`${inline.pattern.source}\\s*\\.\\s*(?:prepare|batch)\\(\\s*\``, 'g');
      let im;
      while ((im = re.exec(src))) {
        const sqlStart = im.index + im[0].length;
        const sqlEnd = src.indexOf('`', sqlStart);
        if (sqlEnd < 0) continue;
        sqlCount += 1;
        const result = analyzeSql(
          stripSqlComments(src.slice(sqlStart, sqlEnd)),
          ddlByBinding.get(inline.id),
          inline.id,
          relFile,
        );
        violations.push(...result.missingTables, ...result.missingColumns);
      }
    }
  }

  // nodeExport 的表→binding 映射是运行时真值，但它拼的是动态 SQL（SELECT * FROM ${table}），
  // 上面的字面量扫描看不到，必须单独核对映射，否则「表在 A 库、映射写 B 库」这种导出缺数据
  // 的问题会一直静默（2026-11-26 的 registry_quota_buckets / lookup_resolve_day_stats 就是）。
  const exportFile = 'apps/worker-a/src/lib/nodeExport.ts';
  const exportSrc = readFileSync(join(root, exportFile), 'utf8');
  const mapStart = exportSrc.indexOf('NODE_EXPORT_TABLE_BINDING');
  if (mapStart >= 0) {
    const mapRe = /^\s*([a-z_][a-z0-9_]*):\s*'(IDENTITY|GOVERNANCE|CONTENT)'/gm;
    const seg = exportSrc.slice(mapStart);
    let mm;
    while ((mm = mapRe.exec(seg))) {
      const table = mm[1].toLowerCase();
      const bindingId = mm[2].toLowerCase();
      const ddl = ddlByBinding.get(bindingId);
      if (!ddl || !ddl.has(table)) {
        violations.push({ table, bindingLabel: bindingId, file: exportFile });
      }
    }
  }

  // 去重（同表/列/文件重复出现只报一次）
  const seen = new Set();
  const unique = [];
  for (const v of violations) {
    const key = v.column
      ? `${v.bindingLabel}|${v.table}.${v.column}|${v.file}`
      : `${v.bindingLabel}|${v.table}|${v.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(v);
  }

  if (report) {
    for (const b of BINDINGS) {
      const ddl = ddlByBinding.get(b.id);
      const cols = [...ddl.values()].reduce((n, s) => n + s.size, 0);
      console.log(`  [report] ${b.id}: ${ddl.size} 张表 / ${cols} 列（${b.dir}）`);
    }
    console.log(`  [report] 扫描 ${files.length} 个 TS 文件，${sqlCount} 条带 binding 的 SQL`);
  }

  if (unique.length === 0) {
    console.log('MIGRATION-COVERAGE 全部通过：代码引用的表/列都在对应 migrations 目录里');
    return;
  }

  console.log(`MIGRATION-COVERAGE 发现 ${unique.length} 处不匹配：`);
  for (const v of unique) {
    if (v.column) {
      console.log(`  - ${v.bindingLabel}: ${v.table}.${v.column} 未在 migrations 定义（${v.file}）`);
    } else {
      console.log(`  - ${v.bindingLabel}: 表 ${v.table} 未在 migrations 定义（${v.file}）`);
    }
  }
  process.exitCode = 1;
}

main();
