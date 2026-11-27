/**
 * CRON-ERROR-VISIBILITY：Cron 任务内部普遍是 try/catch + console.error，
 * budget 层只看到 `ran`。2026-11-26 换域通知缺列/缺表连续静默失败 6 次部署都没被发现，
 * 就是这条盲区。
 *
 * 这里在「单个任务执行窗口」内临时接管 console.error：
 * - 只统计调用次数与样本，不改变任何业务分支；
 * - 结束后立即把原函数引用还原（不是重新包装），避免污染同 isolate 的其它请求；
 * - 并发 HTTP 请求若恰好落在窗口内会被多计，属于「宁可多报」方向，不会漏报。
 */
export type CronErrorCaptureResult = {
  count: number;
  samples: string[];
};

export type CronErrorCapture = {
  dispose: () => CronErrorCaptureResult;
};

const MAX_SAMPLES = 3;
const MAX_SAMPLE_LEN = 120;

function formatSample(args: unknown[]): string {
  const text = args
    .map((arg) => {
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, MAX_SAMPLE_LEN);
}

export function captureCronErrors(): CronErrorCapture {
  // 保存原始引用本身，dispose 时原样赋值回去（不是 bind 后的新函数）
  const originalRef = console.error;
  const callOriginal = originalRef.bind(console);
  const samples: string[] = [];
  let count = 0;

  console.error = (...args: unknown[]) => {
    count += 1;
    if (samples.length < MAX_SAMPLES) samples.push(formatSample(args));
    callOriginal(...args);
  };

  let disposed = false;
  return {
    dispose: () => {
      if (!disposed) {
        console.error = originalRef;
        disposed = true;
      }
      return { count, samples: [...samples] };
    },
  };
}
