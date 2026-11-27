/**
 * M9-7：节点搬家 export / import（站主 JWT + Owner Gateway）。
 * M9-7-S2：正规导入只写 DB_IMPORT；unsafe_inplace_import 按表写三库（A7 Phase3）。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AppVariables } from '../env';
import {
  buildNodeExportBundle,
  estimateBundleJsonBytes,
  importNodeExportBundle,
  isInplaceImportEnabled,
  NODE_EXPORT_MAX_JSON_BYTES,
  NodeExportTooLargeError,
  NodeImportReconcileError,
  promoteStagingImportToSplit,
} from '../lib/nodeExportImport';
import { readImportReadyStatus } from '../lib/nodeImportReconcile';
import { resolveLocalPublicBaseUrl } from '../lib/localPublicBaseUrl';

type AppEnv = { Bindings: Env; Variables: AppVariables };
type Ctx = Context<AppEnv>;

export const nodeMigrateApp = new Hono<AppEnv>();

async function exportOrigin(c: Ctx): Promise<string> {
  try {
    return new URL(c.req.url).origin;
  } catch {
    return (await resolveLocalPublicBaseUrl(c.env)) || 'unknown';
  }
}

nodeMigrateApp.get('/export', async (c) => {
  if (!c.env.ED25519_PRIVATE_KEY?.trim()) {
    return c.json(
      { ok: false, error_code: 'NODE_EXPORT_NOT_CONFIGURED', message: '节点未配置 Ed25519 私钥，无法导出' },
      500,
    );
  }

  try {
    const bundle = await buildNodeExportBundle(c.env, c.env, await exportOrigin(c));
    const json = JSON.stringify(bundle);
    const bytes = estimateBundleJsonBytes(bundle);
    if (bytes > NODE_EXPORT_MAX_JSON_BYTES) {
      return c.json(
        {
          ok: false,
          error_code: 'NODE_EXPORT_TOO_LARGE',
          message: `导出包约 ${Math.round(bytes / 1024)} KB，超过 ${NODE_EXPORT_MAX_JSON_BYTES / 1024 / 1024} MB 上限，请精简数据或联系后续分页导出`,
        },
        400,
      );
    }

    c.header('Content-Type', 'application/json; charset=utf-8');
    c.header('Content-Disposition', 'attachment; filename="hailuo-node-export-v1.json"');
    c.header('Cache-Control', 'no-store');
    return c.body(json);
  } catch (err) {
    if (err instanceof NodeExportTooLargeError) {
      return c.json(
        {
          ok: false,
          error_code: 'NODE_EXPORT_TOO_LARGE',
          message: `表 ${err.table} 超过 ${err.limit} 行导出上限`,
        },
        400,
      );
    }
    console.error('[node-migrate] export 失败', err);
    return c.json(
      { ok: false, error_code: 'NODE_EXPORT_FAILED', message: '导出节点数据失败，请稍后重试' },
      500,
    );
  }
});

nodeMigrateApp.post('/import', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { ok: false, error_code: 'NODE_IMPORT_INVALID', message: '导入文件不是有效 JSON' },
      400,
    );
  }

  const bodyObj =
    body != null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;

  const confirmOverwrite = bodyObj?.confirm_overwrite === true;
  // R-AUDIT-3：原地覆盖逃生口，须与 confirm_overwrite 一并显式声明
  const unsafeInplaceImport = bodyObj?.unsafe_inplace_import === true;
  const inplaceImportEnabled = isInplaceImportEnabled(c.env.NODE_INPLACE_IMPORT_ENABLED);

  const bundle =
    bodyObj && 'bundle' in bodyObj
      ? bodyObj.bundle
      : body;

  // M9-7-S2 / A7-P3：staging → DB_IMPORT；inplace → 三库按表选库（禁 c.env.DB）
  const mode = unsafeInplaceImport ? 'inplace' : 'staging';
  if (mode === 'staging' && !c.env.DB_IMPORT) {
    return c.json(
      {
        ok: false,
        error_code: 'NODE_IMPORT_STAGING_MISSING',
        message:
          '未配置 DB_IMPORT staging 库。请创建 hailuo-node-db-{同组码}-import 并写入 wrangler.toml，或仅在紧急时使用 unsafe_inplace_import',
      },
      503,
    );
  }

  try {
    const data = await importNodeExportBundle(c.env, bundle, {
      confirmOverwrite,
      mode,
      unsafeInplaceImport,
      inplaceImportEnabled,
    });
    return c.json({ ok: true, data });
  } catch (err) {
    if (err instanceof NodeImportReconcileError) {
      return c.json(
        {
          ok: false,
          error_code: 'NODE_IMPORT_RECONCILE_FAILED',
          message: `staging 对账失败：${err.report.mismatches.slice(0, 5).join('; ') || 'COUNT/hash 不一致'}（已写 import_ready=false）`,
          data: {
            import_target: 'DB_IMPORT',
            import_ready: false,
            reconcile: err.report,
          },
        },
        409,
      );
    }
    const code = err instanceof Error ? err.message : 'NODE_IMPORT_FAILED';
    if (code === 'NODE_IMPORT_DISABLED') {
      return c.json(
        {
          ok: false,
          error_code: 'NODE_IMPORT_DISABLED',
          message:
            '原地导入已由 NODE_INPLACE_IMPORT_ENABLED 默认关闭。仅运维显式设为 true 后方可使用；推荐导入到 DB_IMPORT 后脚本切流',
        },
        403,
      );
    }
    if (code === 'NODE_IMPORT_TOTP_PRESENT') {
      return c.json(
        {
          ok: false,
          error_code: 'NODE_IMPORT_TOTP_PRESENT',
          message:
            '目标库仍有 owner_totp_* 数据；导入不会清理 TOTP。请先停用二次验证后再导入，或改用空的 DB_IMPORT staging',
        },
        409,
      );
    }
    if (code === 'NODE_IMPORT_UNSAFE_REQUIRED') {
      return c.json(
        {
          ok: false,
          error_code: 'NODE_IMPORT_UNSAFE_REQUIRED',
          message:
            '原地覆盖导入须在请求体同时设置 unsafe_inplace_import: true 与 confirm_overwrite: true（推荐改为 DB_IMPORT staging）',
        },
        400,
      );
    }
    if (code === 'NODE_IMPORT_CONFIRM_REQUIRED') {
      return c.json(
        {
          ok: false,
          error_code: 'NODE_IMPORT_CONFIRM_REQUIRED',
          message: '目标库已有数据，请在请求体设置 confirm_overwrite: true 后再导入',
        },
        409,
      );
    }
    if (code === 'NODE_IMPORT_INVALID') {
      return c.json(
        { ok: false, error_code: 'NODE_IMPORT_INVALID', message: '导入包格式或 schema_version 无效' },
        400,
      );
    }
    if (code === 'NODE_IMPORT_INVALID_COLUMN') {
      return c.json(
        {
          ok: false,
          error_code: 'NODE_IMPORT_INVALID_COLUMN',
          message: '导入列名非法或不在目标表 schema 中，已拒绝（未清库）',
        },
        400,
      );
    }
    if (code === 'NODE_IMPORT_FORBIDDEN_TABLE') {
      return c.json(
        { ok: false, error_code: 'NODE_IMPORT_FORBIDDEN_TABLE', message: '导入包含有不允许的表名' },
        400,
      );
    }
    console.error('[node-migrate] import 失败', err);
    return c.json(
      { ok: false, error_code: 'NODE_IMPORT_FAILED', message: '导入节点数据失败，请检查文件后重试' },
      500,
    );
  }
});

/** M9-7-S3：读取 staging import_ready / 对账报告（切流脚本与面板用） */
nodeMigrateApp.get('/import-status', async (c) => {
  if (!c.env.DB_IMPORT) {
    return c.json(
      {
        ok: false,
        error_code: 'NODE_IMPORT_STAGING_MISSING',
        message: '未配置 DB_IMPORT staging 库',
      },
      503,
    );
  }
  try {
    const status = await readImportReadyStatus(c.env.DB_IMPORT);
    return c.json({
      ok: true,
      data: {
        import_target: 'DB_IMPORT' as const,
        import_ready: status.import_ready,
        reconcile: status.reconcile,
      },
    });
  } catch (err) {
    console.error('[node-migrate] import-status 失败', err);
    return c.json(
      { ok: false, error_code: 'NODE_IMPORT_STATUS_FAILED', message: '读取 staging 对账状态失败' },
      500,
    );
  }
});

/**
 * A7-DB-RETIRE：staging → 三库切流（替代旧 cutover 交换 DB↔DB_IMPORT id）。
 * POST body: { confirm_promote: true, confirm_overwrite?: true }
 */
nodeMigrateApp.post('/import/promote-staging', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const bodyObj =
    body != null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  const confirmPromote = bodyObj?.confirm_promote === true;
  const confirmOverwrite = bodyObj?.confirm_overwrite === true;

  try {
    const data = await promoteStagingImportToSplit(c.env, {
      confirmPromote,
      confirmOverwrite,
    });
    return c.json({ ok: true, data });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'NODE_IMPORT_PROMOTE_FAILED';
    if (code === 'NODE_IMPORT_PROMOTE_CONFIRM_REQUIRED') {
      return c.json(
        {
          ok: false,
          error_code: code,
          message: '请在请求体设置 confirm_promote: true 后再切流',
        },
        400,
      );
    }
    if (code === 'NODE_IMPORT_STAGING_MISSING') {
      return c.json(
        {
          ok: false,
          error_code: code,
          message: '未配置 DB_IMPORT staging 库',
        },
        503,
      );
    }
    if (code === 'NODE_IMPORT_NOT_READY') {
      return c.json(
        {
          ok: false,
          error_code: code,
          message: 'staging import_ready 不为 true；请先完成导入对账',
        },
        409,
      );
    }
    if (code === 'NODE_IMPORT_CONFIRM_REQUIRED') {
      return c.json(
        {
          ok: false,
          error_code: code,
          message: '三库 IDENTITY 已有 users 数据；请设置 confirm_overwrite: true 后再切流',
        },
        409,
      );
    }
    if (code === 'NODE_IMPORT_TOTP_PRESENT') {
      return c.json(
        {
          ok: false,
          error_code: code,
          message: '目标三库或 staging 仍有 owner_totp_*；请先停用二次验证后再切流',
        },
        409,
      );
    }
    if (code.startsWith('NODE_IMPORT_PROMOTE_TOO_LARGE:')) {
      const table = code.slice('NODE_IMPORT_PROMOTE_TOO_LARGE:'.length);
      return c.json(
        {
          ok: false,
          error_code: 'NODE_IMPORT_PROMOTE_TOO_LARGE',
          message: `表 ${table} 超过单表导出上限，无法切流；请精简数据或联系分页方案`,
        },
        400,
      );
    }
    console.error('[node-migrate] promote-staging 失败', err);
    return c.json(
      { ok: false, error_code: 'NODE_IMPORT_PROMOTE_FAILED', message: 'staging 灌入三库失败' },
      500,
    );
  }
});
