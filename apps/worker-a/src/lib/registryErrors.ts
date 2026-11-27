/**
 * 注册中心出站错误类型（供 router / handle 解析等共用，避免循环 import）。
 */

/** 所有候选中心均不可用（重试耗尽）。 */
export class RegistryAllUnavailableError extends Error {
  readonly code = 'REGISTRY_ALL_UNAVAILABLE';

  constructor(message = '所有注册中心均不可用') {
    super(message);
    this.name = 'RegistryAllUnavailableError';
  }
}

/** 400 / 本地签名失败 / 缺凭证等：立即失败，不 failover。 */
export class RegistryFatalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RegistryFatalError';
    this.code = code;
  }
}
