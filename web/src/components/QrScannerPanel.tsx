/** @jsxImportSource preact */
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Camera, FileScan, MonitorUp, X } from 'lucide-preact';
import { initLanguage, t } from '../lib/i18n';

interface QrScannerPanelProps {
  readonly onResult: (value: string) => void;
}

interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<readonly { rawValue?: string }[]>;
}

type BarcodeDetectorCtor = new (options?: { formats?: readonly string[] }) => BarcodeDetectorLike;
type ScanMode = 'camera' | 'screen';

type ZxingModule = typeof import('@zxing/browser');
type QrReader = InstanceType<ZxingModule['BrowserQRCodeReader']>;
type ScannerControls = Awaited<ReturnType<QrReader['decodeFromStream']>>;

let zxingModulePromise: Promise<ZxingModule> | null = null;
let qrReaderPromise: Promise<QrReader> | null = null;

/** M13-5：首次扫码时再拉 @zxing/browser，避免 Follows 页首包体积 */
async function loadZxingModule(): Promise<ZxingModule> {
  if (!zxingModulePromise) {
    zxingModulePromise = import('@zxing/browser');
  }
  return zxingModulePromise;
}

async function getQrReader(): Promise<QrReader> {
  if (!qrReaderPromise) {
    qrReaderPromise = loadZxingModule().then(
      ({ BrowserQRCodeReader }) => new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 200 }),
    );
  }
  return qrReaderPromise;
}

function getBarcodeDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

function normalizeScannedUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function waitForImageLoad(image: HTMLImageElement): Promise<void> {
  if (image.complete && image.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('image load failed'));
  });
}

export function QrScannerPanel({ onResult }: QrScannerPanelProps): VNode {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const controlsRef = useRef<ScannerControls | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [scanMode, setScanMode] = useState<ScanMode | null>(null);
  const scanning = scanMode !== null;

  useEffect(() => {
    initLanguage();
  }, []);

  function applyResult(raw: string): boolean {
    const url = normalizeScannedUrl(raw);
    if (!url) {
      setMessage(t('qrScannerInvalidUrl'));
      return false;
    }
    onResult(url);
    setMessage(t('qrScannerRecognized', undefined, { url }));
    return true;
  }

  function stopActiveScan(): void {
    controlsRef.current?.stop();
    controlsRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setScanMode(null);
  }

  async function scanImageFile(file: File): Promise<void> {
    stopActiveScan();
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    try {
      image.src = objectUrl;
      await waitForImageLoad(image);

      const Ctor = getBarcodeDetectorCtor();
      if (Ctor) {
        const detector = new Ctor({ formats: ['qr_code'] });
        const codes = await detector.detect(image);
        const raw = codes.find((code) => typeof code.rawValue === 'string')?.rawValue;
        if (raw && applyResult(raw)) return;
      }

      // 原生 BarcodeDetector 不可用或未命中时，回落到 ZXing，覆盖更多浏览器。
      const qrReader = await getQrReader();
      const result = await qrReader.decodeFromImageElement(image);
      applyResult(result.getText());
    } catch {
      setMessage(t('qrScannerImageNotFound'));
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function startStreamScan(mode: ScanMode, stream: MediaStream): Promise<void> {
    const video = videoRef.current;
    if (!video) {
      stream.getTracks().forEach((track) => track.stop());
      setMessage(t('qrScannerPreviewInitFailed'));
      return;
    }

    stopActiveScan();
    streamRef.current = stream;
    setScanMode(mode);
    setMessage(mode === 'screen' ? t('qrScannerScreenHint') : t('qrScannerCameraHint'));

    try {
      const qrReader = await getQrReader();
      // getDisplayMedia 只能由用户手势触发，这里手动接入流后交给 ZXing 连续解码。
      const controls = await qrReader.decodeFromStream(stream, video, (result, _error, controlsInCallback) => {
        if (!result) return;
        if (applyResult(result.getText())) {
          controlsInCallback.stop();
          stopActiveScan();
        }
      });
      controlsRef.current = controls;
      stream.getVideoTracks()[0]?.addEventListener('ended', stopActiveScan, { once: true });
    } catch {
      setMessage(mode === 'screen' ? t('qrScannerScreenFailed') : t('qrScannerCameraFailed'));
      stopActiveScan();
    }
  }

  async function openCamera(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage(t('qrScannerCameraUnsupported'));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      await startStreamScan('camera', stream);
    } catch {
      setMessage(t('qrScannerCameraOpenFailed'));
      stopActiveScan();
    }
  }

  async function scanScreen(): Promise<void> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setMessage(t('qrScannerScreenUnsupported'));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      await startStreamScan('screen', stream);
    } catch {
      setMessage(t('qrScannerScreenNotStarted'));
      stopActiveScan();
    }
  }

  useEffect(() => {
    return () => stopActiveScan();
  }, []);

  return (
    <div class="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-black/30">
      <div class="flex flex-wrap gap-2">
        <label class="inline-flex cursor-pointer items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-800 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800">
          <FileScan size={16} aria-hidden={true} />
          {t('qrScannerScanImage')}
          <input
            type="file"
            accept="image/*"
            class="sr-only"
            onChange={(e) => {
              const file = (e.currentTarget as HTMLInputElement).files?.[0];
              if (file) void scanImageFile(file);
              (e.currentTarget as HTMLInputElement).value = '';
            }}
          />
        </label>
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-800 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          onClick={() => void scanScreen()}
          disabled={scanning}
        >
          <MonitorUp size={16} aria-hidden={true} />
          {t('qrScannerScanScreen')}
        </button>
        {!scanning ? (
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-md bg-sky-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-sky-700"
            onClick={() => void openCamera()}
          >
            <Camera size={16} aria-hidden={true} />
            {t('qrScannerOpenCamera')}
          </button>
        ) : (
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-800 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
            onClick={stopActiveScan}
          >
            <X size={16} aria-hidden={true} />
            {scanMode === 'screen' ? t('qrScannerStopScreen') : t('qrScannerCloseCamera')}
          </button>
        )}
      </div>

      <video
        ref={videoRef}
        class={scanning ? 'mt-3 aspect-video w-full rounded-md bg-black object-contain' : 'hidden'}
        muted
        playsInline
      />
      {message && (
        <p class="mt-2 break-all text-xs text-fg2" role={scanning ? 'status' : 'alert'}>
          {message}
        </p>
      )}
    </div>
  );
}
