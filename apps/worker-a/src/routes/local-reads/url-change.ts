/**
 * url-change precheck / confirm / status（M7-30 / M-REFACTOR-1a）
 */
import type { Hono } from 'hono';
import {
  ed25519SignatureHexToRegistryBase64,
  signMessage,
} from '@hailuo/shared-crypto';
import {
  syncUrlChangeProofToKv,
  syncLocalAfterUrlChangeConfirm,
  type UrlChangePrecheckBody,
  type UrlChangeConfirmBody,
} from '../../handlers/registryUrlChange';
import { assertUrlChangeStepUp } from '../../lib/urlChangeStepUp';
import { enqueueUrlChangeLocalReconcile } from '../../lib/urlChangeLocalReconcile';
import { getUrlMoveStatus } from '../../lib/urlChangeNotify';
import { registryFetch } from '../../lib/registryFetch';
import {
  RegistryAllUnavailableError,
  RegistryFatalError,
} from '../../lib/registryRouter';
import type { LocalReadsAppEnv } from './app';

export function registerUrlChangeRoutes(app: Hono<LocalReadsAppEnv>): void {
  app.post('/registry/url-change/precheck', async (c) => {
    let body: UrlChangePrecheckBody;
    try {
      body = (await c.req.json()) as UrlChangePrecheckBody;
    } catch {
      return c.json(
        { ok: false, error_code: 'URL_CHANGE_INVALID', message: '请求体须为有效 JSON' },
        400,
      );
    }
    if (typeof body.new_node_url !== 'string' || !body.new_node_url.trim()) {
      return c.json(
        { ok: false, error_code: 'URL_CHANGE_INVALID', message: '请提供 new_node_url' },
        400,
      );
    }
    if (typeof body.new_worker_b_url !== 'string' || !body.new_worker_b_url.trim()) {
      return c.json(
        { ok: false, error_code: 'URL_CHANGE_INVALID', message: '请提供 new_worker_b_url' },
        400,
      );
    }

    try {
      const res = await registryFetch(c.env, '/api/node/url-change/precheck', {
        method: 'POST',
        body: JSON.stringify({
          new_node_url: body.new_node_url.trim(),
          new_worker_b_url: body.new_worker_b_url.trim(),
        }),
        headers: { 'Content-Type': 'application/json' },
      });
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        return c.json(
          { ok: false, error_code: 'REGISTRY_URL_CHANGE_INVALID', message: '注册中心响应无法解析' },
          502,
        );
      }
      const parsed = payload as { ok?: boolean; data?: { url_change_id?: string; nonce?: string } };
      if (parsed.ok === true && parsed.data?.url_change_id && parsed.data?.nonce) {
        try {
          await syncUrlChangeProofToKv(c.env, {
            url_change_id: parsed.data.url_change_id,
            nonce: parsed.data.nonce,
          });
        } catch (syncErr) {
          console.error('[local-reads/url-change] url_change proof KV 写入失败（registry 已成功）', syncErr);
        }
      }
      const status = res.status;
      return c.json(payload, status as 200 | 400 | 401 | 403 | 409 | 500 | 502 | 503);
    } catch (err) {
      console.error('[local-reads/url-change] 换域预检失败', err);
      if (err instanceof RegistryAllUnavailableError) {
        return c.json(
          { ok: false, error_code: 'REGISTRY_ALL_UNAVAILABLE', message: '注册中心暂不可用，请稍后重试' },
          503,
        );
      }
      if (err instanceof RegistryFatalError) {
        return c.json({ ok: false, error_code: err.code, message: err.message }, 503);
      }
      return c.json(
        { ok: false, error_code: 'URL_CHANGE_PRECHECK_FAILED', message: '换域预检失败，请稍后重试' },
        500,
      );
    }
  });

  app.post('/registry/url-change/confirm', async (c) => {
    let bodyText = '';
    try {
      bodyText = await c.req.text();
    } catch {
      return c.json(
        { ok: false, error_code: 'URL_CHANGE_INVALID', message: '请求体读取失败' },
        400,
      );
    }
    let body: UrlChangeConfirmBody;
    try {
      body = JSON.parse(bodyText) as UrlChangeConfirmBody;
    } catch {
      return c.json(
        { ok: false, error_code: 'URL_CHANGE_INVALID', message: '请求体须为有效 JSON' },
        400,
      );
    }
    if (typeof body.url_change_id !== 'string' || !body.url_change_id.trim().startsWith('ucg_')) {
      return c.json(
        { ok: false, error_code: 'URL_CHANGE_NOT_FOUND', message: '请提供有效的 url_change_id' },
        400,
      );
    }

    const stepUpDenied = await assertUrlChangeStepUp(c, body.step_up, bodyText);
    if (stepUpDenied) {
      return c.json(stepUpDenied.body, stepUpDenied.status);
    }

    const urlChangeId = body.url_change_id.trim();
    let signature = typeof body.signature === 'string' ? body.signature.trim() : '';
    if (!signature) {
      const nonce = typeof body.nonce === 'string' ? body.nonce.trim() : '';
      if (!nonce) {
        return c.json(
          { ok: false, error_code: 'URL_CHANGE_INVALID', message: '请提供 nonce（或由 Worker A 代为签名）' },
          400,
        );
      }
      const privateKey = c.env.ED25519_PRIVATE_KEY?.trim() ?? '';
      if (!privateKey) {
        return c.json(
          { ok: false, error_code: 'MISCONFIGURED', message: '节点 Ed25519 私钥未配置，无法完成换域签名' },
          500,
        );
      }
      try {
        const sigHex = await signMessage(`${urlChangeId}.${nonce}`, privateKey);
        signature = ed25519SignatureHexToRegistryBase64(sigHex);
      } catch (signErr) {
        console.error('[local-reads/url-change] 换域 confirm 签名失败', signErr);
        return c.json(
          { ok: false, error_code: 'URL_CHANGE_SIGN_FAILED', message: '换域签名失败，请稍后重试' },
          500,
        );
      }
    }

    try {
      const res = await registryFetch(c.env, '/api/node/url-change/confirm', {
        method: 'POST',
        body: JSON.stringify({ url_change_id: urlChangeId, signature }),
        headers: { 'Content-Type': 'application/json' },
      });
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        return c.json(
          { ok: false, error_code: 'REGISTRY_URL_CHANGE_INVALID', message: '注册中心响应无法解析' },
          502,
        );
      }
      const parsed = payload as {
        ok?: boolean;
        data?: { node_url?: string; worker_b_url?: string };
      };
      if (parsed.ok === true && parsed.data?.node_url && parsed.data?.worker_b_url) {
        try {
          await syncLocalAfterUrlChangeConfirm(c.env, {
            node_url: parsed.data.node_url,
            worker_b_url: parsed.data.worker_b_url,
            url_change_id: urlChangeId,
          });
        } catch (syncErr) {
          console.error('[local-reads/url-change] 换域本地同步失败（registry 已成功）', syncErr);
          const errMsg = syncErr instanceof Error ? syncErr.message : String(syncErr);
          try {
            await enqueueUrlChangeLocalReconcile(c.env, {
              url_change_id: urlChangeId,
              node_url: parsed.data.node_url,
              worker_b_url: parsed.data.worker_b_url,
              last_error: errMsg,
            });
          } catch (enqueueErr) {
            console.error('[local-reads/url-change] reconcile 入队失败', enqueueErr);
          }
          if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            const enriched = payload as Record<string, unknown>;
            const data =
              enriched.data && typeof enriched.data === 'object' && !Array.isArray(enriched.data)
                ? { ...(enriched.data as Record<string, unknown>) }
                : {};
            enriched.data = {
              ...data,
              local_sync: { ok: false, reconcile_pending: true },
            };
            payload = enriched;
          }
        }
      }
      const status = res.status;
      return c.json(payload, status as 200 | 400 | 401 | 403 | 404 | 409 | 410 | 500 | 502 | 503);
    } catch (err) {
      console.error('[local-reads/url-change] 换域确认失败', err);
      if (err instanceof RegistryAllUnavailableError) {
        return c.json(
          { ok: false, error_code: 'REGISTRY_ALL_UNAVAILABLE', message: '注册中心暂不可用，请稍后重试' },
          503,
        );
      }
      if (err instanceof RegistryFatalError) {
        return c.json({ ok: false, error_code: err.code, message: err.message }, 503);
      }
      return c.json(
        { ok: false, error_code: 'URL_CHANGE_CONFIRM_FAILED', message: '换域确认失败，请稍后重试' },
        500,
      );
    }
  });

  app.get('/registry/url-change/status', async (c) => {
    const probeRaw = (c.req.query('probe_old') ?? '').trim().toLowerCase();
    const probeOld = probeRaw === '1' || probeRaw === 'true' || probeRaw === 'yes';
    try {
      const data = await getUrlMoveStatus(c.env, { probeOld });
      return c.json({ ok: true, data });
    } catch (err) {
      console.error('[local-reads/url-change] url-change status 失败', err);
      return c.json(
        { ok: false, error_code: 'URL_CHANGE_STATUS_FAILED', message: '读取换域状态失败，请稍后重试' },
        500,
      );
    }
  });
}
