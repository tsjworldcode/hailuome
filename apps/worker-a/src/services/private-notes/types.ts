/**
 * NCF-NOTES-1～5：私有记录 command / result / 窄依赖。
 * 契约见 docs/m-refactor-ncf-2-plan.md §5.10～§5.15。
 * 与 Messaging 域隔离：禁止依赖 dm / groups / messaging-media。
 */

export const PRIVATE_NOTE_CONTENT_MAX_CHARS = 10_000;
export const PRIVATE_NOTE_ATTACHMENT_IDS_MAX = 10;
export const PRIVATE_NOTE_ATTACHMENT_ID_RE = /^att_[a-f0-9]{32}$/;
export const PRIVATE_NOTE_ID_RE = /^note_[a-f0-9]{32}$/;
export const PRIVATE_NOTE_PAGE_LIMIT_DEFAULT = 30;
export const PRIVATE_NOTE_PAGE_LIMIT_MAX = 100;

export type CreatePrivateNoteStatus =
  | 'ok'
  | 'empty'
  | 'content_too_long'
  | 'attachment_not_found'
  | 'internal_error';

export type CreatePrivateNoteCommand = {
  /** 路由透传 body.content；核心 trim + 字数校验 */
  content: unknown;
  /** 路由透传 body.attachment_ids；核心规范化 */
  attachmentIds: unknown;
};

export type PrivateNoteAttachmentItem = {
  id: string;
  storage: string;
  mime: string;
  size_bytes: number | null;
  name: string | null;
  created_at: string;
};

export type PrivateNoteItemData = {
  id: string;
  content: string;
  kind: string;
  attachments: PrivateNoteAttachmentItem[];
  created_at: string;
  updated_at: string;
};

export type CreatePrivateNoteResult = {
  status: CreatePrivateNoteStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: PrivateNoteItemData;
};

/** 待绑定附件行（note_id 必须为 null） */
export type PendingAttachmentRow = {
  id: string;
  note_id: string | null;
  storage: string;
  object_key: string;
  mime: string;
  size_bytes: number | null;
  name: string | null;
  created_at: string;
};

export type CreatePrivateNoteDeps = {
  store: {
    findPendingAttachments(ids: readonly string[]): Promise<PendingAttachmentRow[]>;
    insertNoteWithAttachments(input: {
      id: string;
      content: string;
      kind: string;
      createdAt: string;
      attachmentIds: readonly string[];
    }): Promise<void>;
  };
  ids: {
    newNoteId(): string;
  };
  clock: {
    nowIso(): string;
  };
  /** 禁止写入正文 / 附件字节 */
  logger: {
    error(message: string, err?: unknown): void;
  };
};

// ── NCF-NOTES-2：列表 ──────────────────────────────────────────

export type ListPrivateNotesStatus = 'ok' | 'internal_error';

export type ListPrivateNotesCommand = {
  /** query `limit` */
  limit: unknown;
  /** query `before`（`created_at|id`） */
  before: unknown;
  /** query `q`（可选正文模糊搜；加密正文仅匹配密文） */
  q: unknown;
};

export type ListPrivateNotesPageData = {
  items: PrivateNoteItemData[];
  cursor: string | null;
  has_more: boolean;
};

export type ListPrivateNotesResult = {
  status: ListPrivateNotesStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: ListPrivateNotesPageData;
};

export type ListPrivateNoteRow = {
  id: string;
  content: string;
  kind: string;
  created_at: string;
  updated_at: string;
};

/** 已绑定到记录的附件行 */
export type BoundAttachmentRow = PendingAttachmentRow;

export type ListPrivateNotesCursor = {
  createdAt: string;
  id: string | null;
};

export type ListPrivateNotesDeps = {
  store: {
    listNotes(input: {
      limitPlusOne: number;
      search: string | null;
      cursor: ListPrivateNotesCursor | null;
    }): Promise<ListPrivateNoteRow[]>;
    readAttachmentsForNotes(
      noteIds: readonly string[],
    ): Promise<Map<string, BoundAttachmentRow[]>>;
  };
  /** 禁止 dump 正文 / 搜索词 */
  logger: {
    error(message: string, err?: unknown): void;
  };
};

// ── NCF-NOTES-3：更新 ──────────────────────────────────────────

export type PatchPrivateNoteStatus =
  | 'ok'
  | 'not_found'
  | 'empty'
  | 'content_too_long'
  | 'internal_error';

export type PatchPrivateNoteCommand = {
  /** 路径参数 id */
  id: unknown;
  /** 路由透传 body.content */
  content: unknown;
};

export type PatchPrivateNoteResult = {
  status: PatchPrivateNoteStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: PrivateNoteItemData;
};

export type PatchPrivateNoteDeps = {
  store: {
    findActiveNote(id: string): Promise<ListPrivateNoteRow | null>;
    readAttachmentsForNote(noteId: string): Promise<BoundAttachmentRow[]>;
    /** 返回受影响行数；0 视为并发删光 */
    updateNoteContent(input: {
      id: string;
      content: string;
      kind: string;
      updatedAt: string;
    }): Promise<number>;
  };
  clock: {
    nowIso(): string;
  };
  /** 禁止 dump 正文 */
  logger: {
    error(message: string, err?: unknown): void;
  };
};

// ── NCF-NOTES-4：附件 ──────────────────────────────────────────

export type PrivateNotePrivateStorage = 'filebase_private' | 'b2_private' | 'kv_private';

export type UploadPrivateNoteAttachmentStatus =
  | 'ok'
  | 'storage_full'
  | 'too_large'
  | 'length_required'
  | 'empty'
  | 'invalid_type'
  | 'config_unavailable'
  | 'internal_error';

export type UploadPrivateNoteAttachmentCommand = {
  contentType: string;
  contentLengthHeader: string | null;
  fileNameHeader: string | null;
};

export type UploadPrivateNoteAttachmentResult = {
  status: UploadPrivateNoteAttachmentStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: PrivateNoteAttachmentItem;
};

export type UploadPrivateNoteAttachmentBody = {
  getStream(): ReadableStream | null;
  getArrayBuffer(): Promise<ArrayBuffer>;
};

export type UploadPrivateNoteAttachmentDeps = {
  storage: {
    choose(
      contentType: string,
      declaredSize: number | null,
    ): Promise<PrivateNotePrivateStorage | null>;
    maxBytes(storage: PrivateNotePrivateStorage): number;
  };
  blobs: {
    uploadFilebase(input: {
      objectKey: string;
      body: ReadableStream;
      contentType: string;
      contentLengthHeader: string;
    }): Promise<void>;
    uploadB2(input: {
      objectKey: string;
      body: ReadableStream;
      contentType: string;
      contentLengthHeader: string;
    }): Promise<void>;
    putKv(input: {
      objectKey: string;
      data: ArrayBuffer;
      contentType: string;
    }): Promise<void>;
    filebaseConfigured(): Promise<boolean>;
    b2Configured(): Promise<boolean>;
  };
  usage: {
    finalize(backend: 'filebase' | 'b2' | 'kv', sizeBytes: number): Promise<void>;
  };
  store: {
    insertPendingAttachment(row: {
      id: string;
      storage: PrivateNotePrivateStorage;
      objectKey: string;
      mime: string;
      sizeBytes: number | null;
      name: string | null;
      createdAt: string;
    }): Promise<void>;
  };
  ids: { newAttachmentId(): string };
  clock: { nowIso(): string };
  logger: { error(message: string, err?: unknown): void };
};

export type ServePrivateNoteAttachmentStatus = 'ok' | 'not_found';

export type ServePrivateNoteAttachmentCommand = { id: unknown };

export type ServePrivateNoteAttachmentData = {
  body: BodyInit;
  mime: string;
  size_bytes: number | null;
  contentLength: string | null;
  etag: string | null;
};

export type ServePrivateNoteAttachmentResult = {
  status: ServePrivateNoteAttachmentStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: ServePrivateNoteAttachmentData;
};

export type ServePrivateNoteAttachmentDeps = {
  store: {
    findActiveAttachment(id: string): Promise<{
      id: string;
      storage: string;
      object_key: string;
      mime: string;
      size_bytes: number | null;
    } | null>;
  };
  blobs: {
    fetchKv(objectKey: string): Promise<ArrayBuffer | null>;
    fetchFilebase(objectKey: string): Promise<{
      body: ReadableStream;
      contentLength: string | null;
      etag: string | null;
    } | null>;
    fetchB2(objectKey: string): Promise<{
      body: ReadableStream;
      contentLength: string | null;
      etag: string | null;
    } | null>;
  };
  logger: { error(message: string, err?: unknown): void };
};

export type DeletePrivateNoteAttachmentStatus = 'ok' | 'not_found' | 'internal_error';

export type DeletePrivateNoteAttachmentCommand = { id: unknown };

export type DeletePrivateNoteAttachmentResult = {
  status: DeletePrivateNoteAttachmentStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: { id: string; deleted: true };
};

export type DeletePrivateNoteAttachmentDeps = {
  store: {
    findActiveAttachment(id: string): Promise<{
      id: string;
      storage: string;
      object_key: string;
      size_bytes: number | null;
    } | null>;
    softDeleteAttachment(id: string, deletedAt: string): Promise<number>;
  };
  blobs: {
    deleteObject(storage: string, objectKey: string): Promise<void>;
  };
  usage: {
    decrement(storage: string, sizeBytes: number): Promise<void>;
  };
  clock: { nowIso(): string };
  logger: {
    error(message: string, err?: unknown): void;
    warn(message: string, err?: unknown): void;
  };
};

// ── NCF-NOTES-5：删除记录（软删 + 级联附件元数据；不清对象/用量）──

export type DeletePrivateNoteStatus = 'ok' | 'not_found' | 'internal_error';

export type DeletePrivateNoteCommand = { id: unknown };

export type DeletePrivateNoteResult = {
  status: DeletePrivateNoteStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: { id: string; deleted: true };
};

export type DeletePrivateNoteDeps = {
  store: {
    /**
     * 同事务：软删笔记 + 其下未删附件元数据。
     * 返回笔记受影响行数；0 = 不存在或已删。
     */
    softDeleteNoteWithAttachments(id: string, deletedAt: string): Promise<number>;
  };
  clock: { nowIso(): string };
  /** 禁止 dump 正文 / 附件 id 列表 */
  logger: {
    error(message: string, err?: unknown): void;
  };
};

// ── NCF-NOTES-6：导出（上限 + 仅元数据附件；日志脱敏）──

/** 导出笔记上限（含探测 +1 用 LIMIT） */
export const PRIVATE_NOTES_EXPORT_NOTES_MAX = 5_000;
/** 导出附件元数据上限 */
export const PRIVATE_NOTES_EXPORT_ATTACHMENTS_MAX = 10_000;
export const PRIVATE_NOTES_EXPORT_SCHEMA_VERSION = 1;

export type ExportPrivateNotesStatus = 'ok' | 'too_large' | 'internal_error';

/** 导出无入参；路由侧已 JWT */
export type ExportPrivateNotesCommand = Record<string, never>;

export type ExportPrivateNoteRow = {
  id: string;
  content: string;
  kind: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/** 附件元数据行（无 blob 字节；object_key 仅路径提示） */
export type ExportPrivateNoteAttachmentRow = {
  id: string;
  note_id: string | null;
  storage: string;
  object_key: string;
  mime: string;
  size_bytes: number | null;
  name: string | null;
  created_at: string;
  deleted_at: string | null;
};

export type ExportPrivateNotesBundle = {
  meta: {
    schema_version: number;
    exported_at: string;
    /** 恒为 false：不打包附件对象本体 */
    attachments_included: false;
    counts: {
      notes: number;
      attachments: number;
    };
  };
  notes: ExportPrivateNoteRow[];
  attachments: ExportPrivateNoteAttachmentRow[];
};

export type ExportPrivateNotesResult = {
  status: ExportPrivateNotesStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: ExportPrivateNotesBundle;
};

export type ExportPrivateNotesDeps = {
  store: {
    /** LIMIT = max+1，用于探测超限 */
    listNotesForExport(limitPlusOne: number): Promise<ExportPrivateNoteRow[]>;
    listAttachmentMetaForExport(limitPlusOne: number): Promise<ExportPrivateNoteAttachmentRow[]>;
  };
  clock: { nowIso(): string };
  /** 禁止 dump 正文 / object_key / 附件名 */
  logger: {
    error(message: string, err?: unknown): void;
  };
};

// ── NCF-NOTES-7：导入（与 export schema 对齐、分批写 D1、INSERT OR IGNORE 可重试）──

/** 导入与 export 共用上限 */
export const PRIVATE_NOTES_IMPORT_NOTES_MAX = PRIVATE_NOTES_EXPORT_NOTES_MAX;
export const PRIVATE_NOTES_IMPORT_ATTACHMENTS_MAX = PRIVATE_NOTES_EXPORT_ATTACHMENTS_MAX;
/** D1 batch 分块大小（避免单次 batch 过大） */
export const PRIVATE_NOTES_IMPORT_D1_BATCH_SIZE = 100;

export type ImportPrivateNotesStatus = 'ok' | 'invalid' | 'internal_error';

export type ImportPrivateNotesCommand = {
  /** 路由 readJsonBody 后的对象；核心校验 schema 与行格式 */
  body: Record<string, unknown>;
};

export type ImportPrivateNotesResultData = {
  imported_notes: number;
  skipped_notes: number;
  imported_attachments: number;
  skipped_attachments: number;
  /** 恒为 false：不导入附件对象本体，仅元数据 */
  attachments_included: false;
};

export type ImportPrivateNotesResult = {
  status: ImportPrivateNotesStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: ImportPrivateNotesResultData;
};

export type ImportPrivateNotesDeps = {
  store: {
    /**
     * INSERT OR IGNORE 分批写入；返回每条 statement 的 changes 数（先 notes 后 attachments）。
     * 空数组表示无待写行（可重试、幂等）。
     */
    importSnapshot(input: {
      notes: ExportPrivateNoteRow[];
      attachments: ExportPrivateNoteAttachmentRow[];
    }): Promise<{ changes: number[] }>;
  };
  /** 禁止 dump 正文 / object_key / 附件名 */
  logger: {
    error(message: string, err?: unknown): void;
  };
};

// ── NCF-NOTES-8：包裹主密钥（E2E 加密链路；Worker 只存密文不解包）──

/** D1 行主键（单租户单条） */
export const PRIVATE_NOTES_WRAPPED_KEY_ROW_ID = 'default';
/** wrapped_key_json 字符串上限 */
export const PRIVATE_NOTES_WRAPPED_KEY_JSON_MAX = 4096;

export type PrivateNotesWrappedKeyStoredRow = {
  key_epoch: number;
  wrapped_key_json: string;
  updated_at: string;
};

export type PrivateNotesWrappedKeyDisabledData = {
  enabled: false;
};

export type PrivateNotesWrappedKeyEnabledData = {
  enabled: true;
  key_epoch: number;
  wrapped_key_json: string;
  updated_at: string;
};

export type PrivateNotesWrappedKeyPutOkData = {
  enabled: true;
  key_epoch: number;
  updated_at: string;
};

export type GetPrivateNotesWrappedKeyStatus = 'ok' | 'internal_error';

export type GetPrivateNotesWrappedKeyCommand = Record<string, never>;

export type GetPrivateNotesWrappedKeyResult = {
  status: GetPrivateNotesWrappedKeyStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: PrivateNotesWrappedKeyDisabledData | PrivateNotesWrappedKeyEnabledData;
};

export type GetPrivateNotesWrappedKeyDeps = {
  store: {
    loadWrappedKey(): Promise<PrivateNotesWrappedKeyStoredRow | null>;
  };
  /** 禁止 dump wrapped_key_json */
  logger: {
    error(message: string, err?: unknown): void;
  };
};

export type PutPrivateNotesWrappedKeyStatus = 'ok' | 'invalid_body' | 'internal_error';

export type PutPrivateNotesWrappedKeyCommand = {
  body: Record<string, unknown>;
};

export type PutPrivateNotesWrappedKeyResult = {
  status: PutPrivateNotesWrappedKeyStatus;
  httpStatus: number;
  error_code?: string;
  message?: string;
  data?: PrivateNotesWrappedKeyPutOkData;
};

export type PutPrivateNotesWrappedKeyDeps = {
  store: {
    upsertWrappedKey(input: {
      keyEpoch: number;
      wrappedKeyJson: string;
      updatedAt: string;
    }): Promise<void>;
  };
  clock: { nowIso(): string };
  /** 禁止 dump wrapped_key_json */
  logger: {
    error(message: string, err?: unknown): void;
  };
};
