// M7-1 / M-REFACTOR-1b：legacy facade — 全仓 import 迁完前保留本路径
// §F-02：实现已迁至 workerA/ 子目录；本文件仅 re-export。
export {
  createWorkerAClient,
  buildQuery,
  createWorkerATransport,
} from './workerA/index';
export type { WorkerATransport } from './workerA/index';
export type * from './workerA/types';
