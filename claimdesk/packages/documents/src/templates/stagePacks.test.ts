// owned by ap-paperwork
/** STAGE_PACKS integrity (docs/SUPREME-AUTOPILOT.md §J.1 signing): every template id is registered, every variant exists. */
import { describe, expect, it } from 'vitest';
import { PACK_STAGES, STAGE_PACKS, isDocxTemplateId } from '@ccguk/domain';
import { BUILTIN_DOCX_TEMPLATES } from '../docx/fields/builtin/index.js';
import { getTemplate, hasTemplate } from '../registry.js';
import './index.js';

describe('STAGE_PACKS against the template registries', () => {
  for (const stage of PACK_STAGES) {
    for (const item of STAGE_PACKS[stage]) {
      it(`${stage}: ${item.templateId}${item.variant ? ` (${item.variant})` : ''} exists`, () => {
        if (isDocxTemplateId(item.templateId)) {
          const t = BUILTIN_DOCX_TEMPLATES.find((x) => x.id === item.templateId);
          expect(t, `${item.templateId} is not a built-in Word template`).toBeDefined();
          if (item.variant) expect(t!.variants.map((v) => v.id), `${item.templateId} has no variant ${item.variant}`).toContain(item.variant);
          expect(hasTemplate(item.templateId)).toBe(false);
        } else {
          expect(hasTemplate(item.templateId), `${item.templateId} is not registered`).toBe(true);
          expect(item.variant, 'HTML templates have no variants').toBeUndefined();
          const meta = getTemplate(item.templateId);
          if (item.purpose === 'send_insurer') expect(meta.recipientRole).toBe('at_fault_insurer');
        }
      });
    }
  }
});
