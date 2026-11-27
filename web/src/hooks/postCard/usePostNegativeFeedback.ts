/**
 * NCF-WEB-2：负反馈「不感兴趣」。
 */
import { useState } from 'preact/hooks';
import { isQuotaExceeded } from '../../lib/idbErrors';
import { showToast } from '../../lib/toast';
import { t } from '../../lib/i18n';
import { isNegativelyFedBack, recordNegativeFeedback } from '../../lib/forYou';

export type UsePostNegativeFeedbackArgs = {
  isOfficialPost: boolean;
  negativeFeedbackHandle: string;
};

export function usePostNegativeFeedback({
  isOfficialPost,
  negativeFeedbackHandle,
}: UsePostNegativeFeedbackArgs) {
  // M7-8c：负反馈「不感兴趣」状态机
  const [hidden, setHidden] = useState(
    () => !isOfficialPost && isNegativelyFedBack(negativeFeedbackHandle),
  );
  const [negativeBusy, setNegativeBusy] = useState(false);

  async function handleNegativeFeedback(): Promise<void> {
    if (isOfficialPost || negativeBusy || hidden) return;
    setNegativeBusy(true);
    try {
      await recordNegativeFeedback(negativeFeedbackHandle);
      setHidden(true);
    } catch (err) {
      // session 隐藏已生效；IDB 失败时提示用户（M7-32c）
      setHidden(true);
      if (isQuotaExceeded(err)) {
        showToast(t('localStorageQuotaExceeded'), 'error');
      } else {
        showToast(t('negativeFeedbackPersistFailed'), 'error');
      }
    } finally {
      setNegativeBusy(false);
    }
  }

  return { hidden, negativeBusy, handleNegativeFeedback };
}
