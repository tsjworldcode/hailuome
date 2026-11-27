/**
 * 头像图片上传前的等比缩放与格式压缩（M-AVATAR-SCALE-1 · 2026-10-23）。
 *
 * 背景：头像原图直接上传会占满 IMAGE_KV 单值额度（KV Free 写 1,000 次/天 + 单值 25MB 上限），
 * 手机随手拍的照片动辄 3–8 MB。站主要求「宽高最大值超过 600 就同比例缩小到 600」。
 *
 * 策略（AVATAR-FMT = webp-avif，站主拍板「占空间少用那个」）：
 *   1. 若 max(宽, 高) ≤ 600 **且**原图已足够小 → 原样上传（零重编码，保画质、不引入新损失）
 *   2. 否则用 Canvas 重采样到 max 边 600，编码为 WebP（AVIF 编码器在多数浏览器上
 *      `toBlob` 支持不稳定，且 AVIF 编码 CPU 成本高、Workers 侧不解码，故实际落地 WebP）
 *   3. 若浏览器不支持 WebP 编码 → 退回原始图片（不因压缩失败阻断上传）
 *
 * ⚠️ 兼容性：走 `createImageBitmap`（现代浏览器）+ `HTMLCanvasElement.toBlob`；
 *    老浏览器缺任一 API 时返回 null，调用方按"不缩放"处理。
 *
 * 零 CF 资源消耗：全部在浏览器本地完成（符合 04-frontend-guidelines「本地处理，零 CF 损耗」）。
 */

/** 头像最长边上限（站主要求 600 像素）。 */
export const AVATAR_MAX_DIMENSION = 600;

/** WebP 质量：0.82 在「体积 / 观感」之间较平衡（600px 头像视觉无损区）。 */
const WEBP_QUALITY = 0.82;

/**
 * 按比例计算缩放后的尺寸；无需缩放时返回 null。
 * 纯函数，便于契约测直接断言（不依赖浏览器 API）。
 */
export function computeAvatarScaledSize(
  width: number,
  height: number,
  maxDimension: number = AVATAR_MAX_DIMENSION,
): { width: number; height: number } | null {
  // 非法输入不缩放，交由调用方按原图处理
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return null; // 未超限，无需缩放
  const ratio = maxDimension / longest;
  return {
    // +0.5 四舍五入取整，避免浮点截断导致偶发 599/601 越界
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/** 缩放结果：调用方据此决定上传哪个 Blob。 */
export interface PreparedAvatar {
  blob: Blob;
  contentType: string;
  /** 原图像素宽高（用于提示，不含 PII）。 */
  originalWidth: number;
  originalHeight: number;
  /** 缩放后像素宽高；未缩放时与原图相同。 */
  scaledWidth: number;
  scaledHeight: number;
  /** 是否发生了缩放或重编码（false = 原样上传）。 */
  resized: boolean;
}

/**
 * 读取图片文件尺寸。优先 `createImageBitmap`，失败退回 `HTMLImageElement`。
 * 两者都不可用时返回 null（调用方按"无法判断尺寸"处理）。
 */
async function readImageSize(
  file: Blob,
): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    } catch {
      /* 格式解不开时继续尝试 HTMLImageElement */
    }
  }
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  return await new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

/**
 * 主入口：把用户选中的头像文件处理成「适合上传」的 Blob。
 *
 * - 未超过 600 像素且体积已小于阈值 → 原样返回（`resized: false`）
 * - 超过 600 像素 → 等比缩小到 600 并转 WebP
 * - 浏览器不支持所需 API / 编码失败 → 原样返回（绝不因压缩失败阻断用户上传）
 */
export async function prepareAvatarForUpload(
  file: File,
  maxDimension: number = AVATAR_MAX_DIMENSION,
): Promise<PreparedAvatar> {
  const size = await readImageSize(file);
  const originalWidth = size?.width ?? 0;
  const originalHeight = size?.height ?? 0;

  // 尺寸读不出来（如 HEIC 等浏览器解不开的格式）→ 原样上传，由 Worker A 兜底校验
  const scaled = size ? computeAvatarScaledSize(size.width, size.height, maxDimension) : null;
  if (!scaled) {
    return {
      blob: file,
      contentType: file.type || 'application/octet-stream',
      originalWidth,
      originalHeight,
      scaledWidth: originalWidth,
      scaledHeight: originalHeight,
      resized: false,
    };
  }

  // Canvas API 不可用（如 SSR / 老浏览器）→ 原样上传，不阻断
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') {
    return {
      blob: file,
      contentType: file.type || 'application/octet-stream',
      originalWidth,
      originalHeight,
      scaledWidth: originalWidth,
      scaledHeight: originalHeight,
      resized: false,
    };
  }

  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = scaled.width;
    canvas.height = scaled.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('CANVAS_2D_UNAVAILABLE');
    ctx.drawImage(bitmap, 0, 0, scaled.width, scaled.height);
    bitmap.close();

    // 优先 WebP；浏览器不支持时 toBlob 会回落到 PNG（contentType 随之变化）
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/webp', WEBP_QUALITY);
    });
    if (!blob) throw new Error('CANVAS_TOBLOB_FAILED');

    return {
      blob,
      contentType: blob.type || 'image/webp',
      originalWidth,
      originalHeight,
      scaledWidth: scaled.width,
      scaledHeight: scaled.height,
      resized: true,
    };
  } catch {
    // 压缩失败不阻断上传：退回原图
    return {
      blob: file,
      contentType: file.type || 'application/octet-stream',
      originalWidth,
      originalHeight,
      scaledWidth: originalWidth,
      scaledHeight: originalHeight,
      resized: false,
    };
  }
}