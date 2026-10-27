import { TranslatedCode } from './types';
import { EXCEPTION_OVERRIDES } from './exception-overrides';

export interface AppliedExceptionTarget {
  originalCode: string;
  code: string | null;
  display?: string;
  valuesetId?: string;
  includeDescendants: boolean;
}

/** Review candidates only. Brand names and supplier renames can be legitimate mismatches. */
export function exceptionTranslationMismatches(exceptions: Array<{ code: string; displayName?: string }>,
  translations: Record<string, TranslatedCode | null>, appliedTargets?: AppliedExceptionTarget[]) {
  const generic = new Set('product containing only medicinal clinical drug oral tablet tablets capsule capsules solution suspension topical injection mg ml micrograms cream ointment sodium phosphate dose spray drops soluble modified prolonged release gastro resistant preservative free sugar aqueous powder inhalation nebuliser nasal eye ear dry'.split(' '));
  const tokens = (s: string) => (s.toLowerCase().match(/[a-z]{3,}/g) || []).filter(t => !generic.has(t));
  return [...new Map(exceptions.map(e => [e.code, e])).values()].flatMap(e => {
    const target = translations[e.code];
    const mismatch = (display: string) => !tokens(e.displayName || '').some(t => tokens(display).includes(t));
    const translationMismatch = !!target?.display && mismatch(target.display);
    const applied = appliedTargets?.filter(a => a.originalCode === e.code) || [];
    const unique = [...new Map(applied.map(a => [`${a.code}|${a.includeDescendants}`, a])).values()];
    return (unique.length ? unique : [null]).flatMap(a => {
      const appliedMismatch = !!a?.code && (!a.display || mismatch(a.display));
      if (!translationMismatch && !appliedMismatch) return [];
      return [{ originalCode: e.code, originalDisplay: e.displayName || '', targetCode: target?.code || null,
        targetDisplay: target?.display || null, applied_target: a?.code || null, applied_target_display: a?.display || null,
        applied_scope: a ? a.includeDescendants ? 'descendants' : 'exact' : null,
        valueset_ids: applied.filter(row => row.code === a?.code && row.includeDescendants === a?.includeDescendants)
          .flatMap(row => row.valuesetId ? [row.valuesetId] : []),
        translation_mismatch: translationMismatch, applied_mismatch: appliedMismatch,
        overrideVersion: EXCEPTION_OVERRIDES.find(o => o.emisCode === e.code)?.version || null,
        reason: a?.code && !a.display ? 'Applied target display unavailable; review target, do not infer a replacement'
          : 'No shared ingredient or brand name token in translation or applied target; review, do not infer a replacement' }];
    });
  });
}
