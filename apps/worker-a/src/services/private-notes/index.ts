/**
 * Private Notes 深模块公开出口（≠ Messaging）。
 * NCF-NOTES-1 创建 · NCF-NOTES-2 列表 · NCF-NOTES-3 更新 · NCF-NOTES-4 附件 · NCF-NOTES-5 删除 · NCF-NOTES-6 导出 · NCF-NOTES-7 导入 · NCF-NOTES-8 wrapped-key。
 */
export type {
  CreatePrivateNoteCommand,
  CreatePrivateNoteDeps,
  CreatePrivateNoteResult,
  CreatePrivateNoteStatus,
  ListPrivateNotesCommand,
  ListPrivateNotesDeps,
  ListPrivateNotesPageData,
  ListPrivateNotesResult,
  ListPrivateNotesStatus,
  PatchPrivateNoteCommand,
  PatchPrivateNoteDeps,
  PatchPrivateNoteResult,
  PatchPrivateNoteStatus,
  DeletePrivateNoteCommand,
  DeletePrivateNoteDeps,
  DeletePrivateNoteResult,
  DeletePrivateNoteStatus,
  ExportPrivateNotesCommand,
  ExportPrivateNotesDeps,
  ExportPrivateNotesResult,
  ExportPrivateNotesStatus,
  ExportPrivateNotesBundle,
  ImportPrivateNotesCommand,
  ImportPrivateNotesDeps,
  ImportPrivateNotesResult,
  ImportPrivateNotesStatus,
  GetPrivateNotesWrappedKeyCommand,
  GetPrivateNotesWrappedKeyDeps,
  GetPrivateNotesWrappedKeyResult,
  GetPrivateNotesWrappedKeyStatus,
  PutPrivateNotesWrappedKeyCommand,
  PutPrivateNotesWrappedKeyDeps,
  PutPrivateNotesWrappedKeyResult,
  PutPrivateNotesWrappedKeyStatus,
  PrivateNotesWrappedKeyEnabledData,
  PrivateNotesWrappedKeyDisabledData,
  UploadPrivateNoteAttachmentCommand,
  UploadPrivateNoteAttachmentResult,
  ServePrivateNoteAttachmentResult,
  DeletePrivateNoteAttachmentResult,
  PrivateNoteItemData,
  PendingAttachmentRow,
  BoundAttachmentRow,
} from './types';
export {
  PRIVATE_NOTE_ATTACHMENT_ID_RE,
  PRIVATE_NOTE_ATTACHMENT_IDS_MAX,
  PRIVATE_NOTE_CONTENT_MAX_CHARS,
  PRIVATE_NOTE_ID_RE,
  PRIVATE_NOTE_PAGE_LIMIT_DEFAULT,
  PRIVATE_NOTE_PAGE_LIMIT_MAX,
  PRIVATE_NOTES_EXPORT_NOTES_MAX,
  PRIVATE_NOTES_EXPORT_ATTACHMENTS_MAX,
  PRIVATE_NOTES_EXPORT_SCHEMA_VERSION,
  PRIVATE_NOTES_IMPORT_NOTES_MAX,
  PRIVATE_NOTES_IMPORT_ATTACHMENTS_MAX,
  PRIVATE_NOTES_IMPORT_D1_BATCH_SIZE,
  PRIVATE_NOTES_WRAPPED_KEY_ROW_ID,
  PRIVATE_NOTES_WRAPPED_KEY_JSON_MAX,
} from './types';
/** @deprecated 兼容 m11 旧常量名：等价 PRIVATE_NOTES_EXPORT_NOTES_MAX */
export { PRIVATE_NOTES_EXPORT_NOTES_MAX as EXPORT_NOTES_MAX } from './types';
export { PRIVATE_NOTE_MAX_KV_BYTES } from './attachmentUtils';
export { runCreatePrivateNote } from './runCreatePrivateNote';
export {
  runListPrivateNotes,
  parseListLimit,
  parseListCursor,
  encodeListCursor,
} from './runListPrivateNotes';
export { runPatchPrivateNote } from './runPatchPrivateNote';
export { runDeletePrivateNote } from './runDeletePrivateNote';
export { runExportPrivateNotes } from './runExportPrivateNotes';
export { runImportPrivateNotes } from './runImportPrivateNotes';
export { runGetPrivateNotesWrappedKey } from './runGetPrivateNotesWrappedKey';
export { runPutPrivateNotesWrappedKey } from './runPutPrivateNotesWrappedKey';
export { runUploadPrivateNoteAttachment } from './runUploadPrivateNoteAttachment';
export { runServePrivateNoteAttachment } from './runServePrivateNoteAttachment';
export { runDeletePrivateNoteAttachment } from './runDeletePrivateNoteAttachment';
export {
  createProductionCreatePrivateNoteDeps,
  createProductionListPrivateNotesDeps,
  createProductionPatchPrivateNoteDeps,
  createProductionDeletePrivateNoteDeps,
  createProductionExportPrivateNotesDeps,
  createProductionImportPrivateNotesDeps,
  createProductionGetPrivateNotesWrappedKeyDeps,
  createProductionPutPrivateNotesWrappedKeyDeps,
} from './adapters/production';
export {
  createProductionUploadPrivateNoteAttachmentDeps,
  createProductionServePrivateNoteAttachmentDeps,
  createProductionDeletePrivateNoteAttachmentDeps,
} from './adapters/attachmentProduction';

import type { Env } from '../../env';
import {
  createProductionCreatePrivateNoteDeps,
  createProductionListPrivateNotesDeps,
  createProductionPatchPrivateNoteDeps,
  createProductionDeletePrivateNoteDeps,
  createProductionExportPrivateNotesDeps,
  createProductionImportPrivateNotesDeps,
  createProductionGetPrivateNotesWrappedKeyDeps,
  createProductionPutPrivateNotesWrappedKeyDeps,
} from './adapters/production';
import {
  createProductionUploadPrivateNoteAttachmentDeps,
  createProductionServePrivateNoteAttachmentDeps,
  createProductionDeletePrivateNoteAttachmentDeps,
} from './adapters/attachmentProduction';
import { runCreatePrivateNote } from './runCreatePrivateNote';
import { runListPrivateNotes } from './runListPrivateNotes';
import { runPatchPrivateNote } from './runPatchPrivateNote';
import { runDeletePrivateNote } from './runDeletePrivateNote';
import { runExportPrivateNotes } from './runExportPrivateNotes';
import { runImportPrivateNotes } from './runImportPrivateNotes';
import { runGetPrivateNotesWrappedKey } from './runGetPrivateNotesWrappedKey';
import { runPutPrivateNotesWrappedKey } from './runPutPrivateNotesWrappedKey';
import { runUploadPrivateNoteAttachment } from './runUploadPrivateNoteAttachment';
import { runServePrivateNoteAttachment } from './runServePrivateNoteAttachment';
import { runDeletePrivateNoteAttachment } from './runDeletePrivateNoteAttachment';
import type {
  CreatePrivateNoteCommand,
  CreatePrivateNoteResult,
  DeletePrivateNoteAttachmentCommand,
  DeletePrivateNoteAttachmentResult,
  DeletePrivateNoteCommand,
  DeletePrivateNoteResult,
  ExportPrivateNotesResult,
  ImportPrivateNotesCommand,
  ImportPrivateNotesResult,
  GetPrivateNotesWrappedKeyResult,
  PutPrivateNotesWrappedKeyCommand,
  PutPrivateNotesWrappedKeyResult,
  ListPrivateNotesCommand,
  ListPrivateNotesResult,
  PatchPrivateNoteCommand,
  PatchPrivateNoteResult,
  ServePrivateNoteAttachmentCommand,
  ServePrivateNoteAttachmentResult,
  UploadPrivateNoteAttachmentBody,
  UploadPrivateNoteAttachmentCommand,
  UploadPrivateNoteAttachmentResult,
} from './types';

/** 生产入口：创建 */
export async function executeCreatePrivateNote(
  env: Env,
  command: CreatePrivateNoteCommand,
): Promise<CreatePrivateNoteResult> {
  return runCreatePrivateNote(command, createProductionCreatePrivateNoteDeps(env));
}

/** 生产入口：列表 */
export async function executeListPrivateNotes(
  env: Env,
  command: ListPrivateNotesCommand,
): Promise<ListPrivateNotesResult> {
  return runListPrivateNotes(command, createProductionListPrivateNotesDeps(env));
}

/** 生产入口：更新 */
export async function executePatchPrivateNote(
  env: Env,
  command: PatchPrivateNoteCommand,
): Promise<PatchPrivateNoteResult> {
  return runPatchPrivateNote(command, createProductionPatchPrivateNoteDeps(env));
}

/** 生产入口：附件上传 */
export async function executeUploadPrivateNoteAttachment(
  env: Env,
  command: UploadPrivateNoteAttachmentCommand,
  body: UploadPrivateNoteAttachmentBody,
): Promise<UploadPrivateNoteAttachmentResult> {
  return runUploadPrivateNoteAttachment(
    command,
    body,
    createProductionUploadPrivateNoteAttachmentDeps(env),
  );
}

/** 生产入口：附件读取 */
export async function executeServePrivateNoteAttachment(
  env: Env,
  command: ServePrivateNoteAttachmentCommand,
): Promise<ServePrivateNoteAttachmentResult> {
  return runServePrivateNoteAttachment(command, createProductionServePrivateNoteAttachmentDeps(env));
}

/** 生产入口：附件删除 */
export async function executeDeletePrivateNoteAttachment(
  env: Env,
  command: DeletePrivateNoteAttachmentCommand,
): Promise<DeletePrivateNoteAttachmentResult> {
  return runDeletePrivateNoteAttachment(command, createProductionDeletePrivateNoteAttachmentDeps(env));
}

/** 生产入口：删除记录（软删 + 级联附件元数据） */
export async function executeDeletePrivateNote(
  env: Env,
  command: DeletePrivateNoteCommand,
): Promise<DeletePrivateNoteResult> {
  return runDeletePrivateNote(command, createProductionDeletePrivateNoteDeps(env));
}

/** 生产入口：导出（上限 + 附件仅元数据） */
export async function executeExportPrivateNotes(env: Env): Promise<ExportPrivateNotesResult> {
  return runExportPrivateNotes({}, createProductionExportPrivateNotesDeps(env));
}

/** 生产入口：导入（与 export schema 对齐 + INSERT OR IGNORE 可重试） */
export async function executeImportPrivateNotes(
  env: Env,
  command: ImportPrivateNotesCommand,
): Promise<ImportPrivateNotesResult> {
  return runImportPrivateNotes(command, createProductionImportPrivateNotesDeps(env));
}

/** 生产入口：读取包裹主密钥状态 */
export async function executeGetPrivateNotesWrappedKey(env: Env): Promise<GetPrivateNotesWrappedKeyResult> {
  return runGetPrivateNotesWrappedKey({}, createProductionGetPrivateNotesWrappedKeyDeps(env));
}

/** 生产入口：写入包裹主密钥 */
export async function executePutPrivateNotesWrappedKey(
  env: Env,
  command: PutPrivateNotesWrappedKeyCommand,
): Promise<PutPrivateNotesWrappedKeyResult> {
  return runPutPrivateNotesWrappedKey(command, createProductionPutPrivateNotesWrappedKeyDeps(env));
}
