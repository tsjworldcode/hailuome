import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AppVariables } from '../env';
import {
  executeCreatePrivateNote,
  executeListPrivateNotes,
  executePatchPrivateNote,
  executeDeletePrivateNote,
  executeExportPrivateNotes,
  executeImportPrivateNotes,
  executeGetPrivateNotesWrappedKey,
  executePutPrivateNotesWrappedKey,
  executeUploadPrivateNoteAttachment,
  executeServePrivateNoteAttachment,
  executeDeletePrivateNoteAttachment,
  type CreatePrivateNoteResult,
  type ListPrivateNotesResult,
  type PatchPrivateNoteResult,
  type DeletePrivateNoteResult,
  type ExportPrivateNotesResult,
  type ImportPrivateNotesResult,
  type GetPrivateNotesWrappedKeyResult,
  type PutPrivateNotesWrappedKeyResult,
  type UploadPrivateNoteAttachmentResult,
  type ServePrivateNoteAttachmentResult,
  type DeletePrivateNoteAttachmentResult,
} from '../services/private-notes';
import { privateAttachmentCacheHeaderFields } from '../services/private-notes/attachmentUtils';

type AppEnv = { Bindings: Env; Variables: AppVariables };
type PrivateNotesContext = Context<AppEnv>;

export const privateNotesApp = new Hono<AppEnv>();

function errorJson(
  c: PrivateNotesContext,
  status: 400 | 404 | 411 | 500 | 501 | 507,
  code: string,
  message: string,
): Response {
  return c.json({ ok: false, error_code: code, message }, status);
}

async function readJsonBody(c: PrivateNotesContext): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

privateNotesApp.get('/', async (c) => {
  // NCF-NOTES-2：列表判定进 services/private-notes
  const result = await executeListPrivateNotes(c.env, {
    limit: c.req.query('limit'),
    before: c.req.query('before'),
    q: c.req.query('q'),
  });
  return listPrivateNotesResultToResponse(c, result);
});

/** NCF-NOTES-2：result → 既有 HTTP JSON */
function listPrivateNotesResultToResponse(
  c: PrivateNotesContext,
  result: ListPrivateNotesResult,
): Response {
  if (result.status === 'ok' && result.data) {
    return c.json({ ok: true, data: result.data });
  }
  return errorJson(
    c,
    result.httpStatus as 500,
    result.error_code ?? 'PRIVATE_NOTE_SAVE_FAILED',
    result.message ?? '读取私有记录失败，请稍后重试',
  );
}
privateNotesApp.get('/export', async (c) => {
  // NCF-NOTES-6：导出判定进 services/private-notes（上限 + 附件仅元数据）
  const result = await executeExportPrivateNotes(c.env);
  return exportPrivateNotesResultToResponse(c, result);
});

/** NCF-NOTES-6：result → 既有 HTTP JSON */
function exportPrivateNotesResultToResponse(
  c: PrivateNotesContext,
  result: ExportPrivateNotesResult,
): Response {
  if (result.status === 'ok' && result.data) {
    return c.json({ ok: true, data: result.data });
  }
  return errorJson(
    c,
    result.httpStatus as 400 | 500,
    result.error_code ?? 'PRIVATE_NOTE_EXPORT_FAILED',
    result.message ?? '导出私有记录失败，请稍后重试',
  );
}

privateNotesApp.post('/import', async (c) => {
  const body = await readJsonBody(c);
  if (!body) return errorJson(c, 400, 'PRIVATE_NOTE_IMPORT_INVALID', '导入文件格式无效');

  // NCF-NOTES-7：导入判定进 services/private-notes（与 export schema 对齐 + 分批幂等合并）
  const result = await executeImportPrivateNotes(c.env, { body });
  return importPrivateNotesResultToResponse(c, result);
});

/** NCF-NOTES-7：result → 既有 HTTP JSON */
function importPrivateNotesResultToResponse(
  c: PrivateNotesContext,
  result: ImportPrivateNotesResult,
): Response {
  if (result.status === 'ok' && result.data) {
    return c.json({ ok: true, data: result.data });
  }
  return errorJson(
    c,
    result.httpStatus as 400 | 500,
    result.error_code ?? 'PRIVATE_NOTE_IMPORT_FAILED',
    result.message ?? '导入私有记录失败，请稍后重试',
  );
}

privateNotesApp.get('/wrapped-key', async (c) => {
  // NCF-NOTES-8：包裹主密钥读取进 services/private-notes
  const result = await executeGetPrivateNotesWrappedKey(c.env);
  return getPrivateNotesWrappedKeyResultToResponse(c, result);
});

/** NCF-NOTES-8：GET wrapped-key result → HTTP JSON */
function getPrivateNotesWrappedKeyResultToResponse(
  c: PrivateNotesContext,
  result: GetPrivateNotesWrappedKeyResult,
): Response {
  if (result.status === 'ok' && result.data) {
    return c.json({ ok: true, data: result.data });
  }
  return errorJson(
    c,
    result.httpStatus as 500,
    result.error_code ?? 'PRIVATE_NOTE_SAVE_FAILED',
    result.message ?? '读取记录加密状态失败，请稍后重试',
  );
}

privateNotesApp.put('/wrapped-key', async (c) => {
  const body = await readJsonBody(c);
  if (!body) return errorJson(c, 400, 'INVALID_BODY', '请求体格式无效');

  // NCF-NOTES-8：包裹主密钥写入进 services/private-notes
  const result = await executePutPrivateNotesWrappedKey(c.env, { body });
  return putPrivateNotesWrappedKeyResultToResponse(c, result);
});

/** NCF-NOTES-8：PUT wrapped-key result → HTTP JSON */
function putPrivateNotesWrappedKeyResultToResponse(
  c: PrivateNotesContext,
  result: PutPrivateNotesWrappedKeyResult,
): Response {
  if (result.status === 'ok' && result.data) {
    return c.json({ ok: true, data: result.data });
  }
  return errorJson(
    c,
    result.httpStatus as 400 | 500,
    result.error_code ?? 'PRIVATE_NOTE_SAVE_FAILED',
    result.message ?? '保存记录加密配置失败，请稍后重试',
  );
}

privateNotesApp.post('/', async (c) => {
  const body = await readJsonBody(c);
  if (!body) return errorJson(c, 400, 'INVALID_BODY', '请求体格式无效');

  // NCF-NOTES-1：创建判定下沉 services/private-notes（≠ Messaging）
  const result = await executeCreatePrivateNote(c.env, {
    content: body.content,
    attachmentIds: body.attachment_ids,
  });
  return createPrivateNoteResultToResponse(c, result);
});

/** NCF-NOTES-1：result → 既有 HTTP JSON */
function createPrivateNoteResultToResponse(
  c: PrivateNotesContext,
  result: CreatePrivateNoteResult,
): Response {
  if (result.status === 'ok' && result.data) {
    return c.json({ ok: true, data: result.data });
  }
  return errorJson(
    c,
    result.httpStatus as 400 | 404 | 500,
    result.error_code ?? 'PRIVATE_NOTE_SAVE_FAILED',
    result.message ?? '保存私有记录失败，请稍后重试',
  );
}

privateNotesApp.post('/attachments', async (c) => {
  // NCF-NOTES-4：附件上传判定进 services/private-notes
  const result = await executeUploadPrivateNoteAttachment(
    c.env,
    {
      contentType: c.req.header('Content-Type')?.trim() || 'application/octet-stream',
      contentLengthHeader: c.req.header('Content-Length') ?? null,
      fileNameHeader: c.req.header('X-File-Name') ?? null,
    },
    {
      getStream: () => c.req.raw.body,
      getArrayBuffer: () => c.req.arrayBuffer(),
    },
  );
  return uploadPrivateNoteAttachmentResultToResponse(c, result);
});

function uploadPrivateNoteAttachmentResultToResponse(
  c: PrivateNotesContext,
  result: UploadPrivateNoteAttachmentResult,
): Response {
  if (result.status === 'ok' && result.data) {
    return c.json({ ok: true, data: result.data });
  }
  return errorJson(
    c,
    result.httpStatus as 400 | 411 | 500 | 507,
    result.error_code ?? 'PRIVATE_NOTE_SAVE_FAILED',
    result.message ?? '上传私有附件失败，请稍后重试',
  );
}

privateNotesApp.get('/attachments/:id/content', async (c) => {
  // NCF-NOTES-4：附件读取
  const result = await executeServePrivateNoteAttachment(c.env, { id: c.req.param('id') });
  return servePrivateNoteAttachmentResultToResponse(result);
});

function servePrivateNoteAttachmentResultToResponse(
  result: ServePrivateNoteAttachmentResult,
): Response {
  if (result.status !== 'ok' || !result.data) {
    return new Response(
      JSON.stringify({
        ok: false,
        error_code: result.error_code ?? 'PRIVATE_NOTE_ATTACHMENT_NOT_FOUND',
        message: result.message ?? '私有附件不存在',
      }),
      {
        status: result.httpStatus,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
  const fields = privateAttachmentCacheHeaderFields(result.data.mime);
  const headers = new Headers();
  headers.set('Content-Type', fields.contentType);
  headers.set('Cache-Control', fields.cacheControl);
  headers.set('Vary', fields.vary);
  if (result.data.contentLength) headers.set('Content-Length', result.data.contentLength);
  if (result.data.etag) headers.set('ETag', result.data.etag);
  return new Response(result.data.body, { headers });
}

privateNotesApp.delete('/attachments/:id', async (c) => {
  // NCF-NOTES-4：附件删除
  const result = await executeDeletePrivateNoteAttachment(c.env, { id: c.req.param('id') });
  return deletePrivateNoteAttachmentResultToResponse(c, result);
});

function deletePrivateNoteAttachmentResultToResponse(
  c: PrivateNotesContext,
  result: DeletePrivateNoteAttachmentResult,
): Response {
  if (result.status === 'ok' && result.data) {
    return c.json({ ok: true, data: result.data });
  }
  return errorJson(
    c,
    result.httpStatus as 404 | 500,
    result.error_code ?? 'PRIVATE_NOTE_SAVE_FAILED',
    result.message ?? '删除私有附件失败，请稍后重试',
  );
}

privateNotesApp.patch('/:id', async (c) => {
  // NCF-NOTES-3：更新判定进 services/private-notes
  const body = await readJsonBody(c);
  if (!body) return errorJson(c, 400, 'INVALID_BODY', '请求体格式无效');
  const result = await executePatchPrivateNote(c.env, {
    id: c.req.param('id'),
    content: body.content,
  });
  return patchPrivateNoteResultToResponse(c, result);
});

/** NCF-NOTES-3：result → 既有 HTTP JSON */
function patchPrivateNoteResultToResponse(
  c: PrivateNotesContext,
  result: PatchPrivateNoteResult,
): Response {
  if (result.status === 'ok' && result.data) {
    return c.json({ ok: true, data: result.data });
  }
  return errorJson(
    c,
    result.httpStatus as 400 | 404 | 500,
    result.error_code ?? 'PRIVATE_NOTE_SAVE_FAILED',
    result.message ?? '更新私有记录失败，请稍后重试',
  );
}

privateNotesApp.delete('/:id', async (c) => {
  // NCF-NOTES-5：删除判定进 services/private-notes（软删 + 级联附件元数据）
  const result = await executeDeletePrivateNote(c.env, { id: c.req.param('id') });
  return deletePrivateNoteResultToResponse(c, result);
});

/** NCF-NOTES-5：result → 既有 HTTP JSON */
function deletePrivateNoteResultToResponse(
  c: PrivateNotesContext,
  result: DeletePrivateNoteResult,
): Response {
  if (result.status === 'ok' && result.data) {
    return c.json({ ok: true, data: result.data });
  }
  return errorJson(
    c,
    result.httpStatus as 404 | 500,
    result.error_code ?? 'PRIVATE_NOTE_SAVE_FAILED',
    result.message ?? '删除私有记录失败，请稍后重试',
  );
}
