import { TranslatedCode } from './types';
import { EXCEPTION_OVERRIDES } from './exception-overrides';

/** Review candidates only. Brand names and supplier renames can be legitimate mismatches. */
export function exceptionTranslationMismatches(exceptions: Array<{ code: string; displayName?: string }>,
  translations: Record<string, TranslatedCode | null>) {
  const generic = new Set('product containing only medicinal clinical drug oral tablet tablets capsule capsules solution suspension topical injection mg ml micrograms cream ointment sodium phosphate dose spray drops soluble modified prolonged release gastro resistant preservative free sugar aqueous powder inhalation nebuliser nasal eye ear dry'.split(' '));
  const tokens = (s: string) => (s.toLowerCase().match(/[a-z]{3,}/g) || []).filter(t => !generic.has(t));
  return [...new Map(exceptions.map(e => [e.code, e])).values()].flatMap(e => {
    const target = translations[e.code];
    if (!target?.display || tokens(e.displayName || '').some(t => tokens(target.display!).includes(t))) return [];
    return [{ originalCode: e.code, originalDisplay: e.displayName || '', targetCode: target.code,
      targetDisplay: target.display, overrideVersion: EXCEPTION_OVERRIDES.find(o => o.emisCode === e.code)?.version || null,
      reason: 'No shared ingredient or brand name token; review translation, do not infer a replacement' }];
  });
}
