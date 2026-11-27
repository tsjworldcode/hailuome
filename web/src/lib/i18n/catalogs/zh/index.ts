/** M-i18n-L2：zh 全量文案合并 */
import common from './common';
import settings from './settings';
import composer from './composer';
import timeline from './timeline';
import messages from './messages';

export default {
  ...common,
  ...settings,
  ...composer,
  ...timeline,
  ...messages,
} as const;
