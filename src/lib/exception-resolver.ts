import { SnomedConcept, TranslatedCode } from './types';

export interface ExceptionResolution {
  originalCode: string;
  code: string | null;
  display?: string;
  error: string | null;
  status: 'resolved_family' | 'inactive_exact' | 'legacy_exact';
  includeDescendants: boolean;
  reason: string;
}

// Include strengths and dosage forms. Clinical exceptions use ConceptMap as before.
export function namesPreparation(name: string): boolean {
  return /\b(tablets?|capsules?|ointments?|creams?|gel|inhaler|inhalation|solution|suspension|injection|spray|drops?|patch|powder|sachets?|suppositories|suppository|pessary|enema|foam|lotion|mouthwash|granules|respules|nebules|rotacaps|tube)\b|\d\s*(mg|micrograms?|mcg|ml|%)/i.test(name);
}

/** Allow the dosage form before or after the strength. Keep ingredient-dose pairs. */
export function preparationKey(name: string): string {
  const forms: string[] = [];
  const text = name.toLowerCase().replace(/\((?:clinical drug|medicinal product|product)\)/g, '')
    .replace(/(\d)\s+(mg|ml|micrograms?|mcg|%)/g, '$1$2')
    .replace(/[^a-z0-9.%/]+/g, ' ')
    .replace(/\b(tablets?|capsules?|ointments?|creams?|gel|solution|suspension|injection|spray|drops?|powder|enema|foam|lotion|mouthwash)\b/g,
      form => { forms.push(form); return ' '; });
  return `${text.trim().replace(/\s+/g, ' ')}|${forms.sort().join(' ')}`;
}

export async function resolveExceptions(
  exceptions: Array<{ code: string; displayName?: string }>,
  translations: Record<string, TranslatedCode | null>,
  historical: Record<string, string>,
  findPreparations: (name: string) => Promise<SnomedConcept[]>,
  findInactivePreparations: (name: string) => Promise<SnomedConcept[]>,
  legacyTargets?: Record<string, string | null>,
): Promise<ExceptionResolution[]> {
  return Promise.all(exceptions.map(async ({ code, displayName = '' }) => {
    const translated = translations[code];
    const legacyExact = (reason: string): ExceptionResolution => {
      if (legacyTargets && !Object.hasOwn(legacyTargets, code)) throw new Error(`Missing legacy exception target for ${code}`);
      const target = legacyTargets ? legacyTargets[code] : translated ? historical[translated.code] || translated.code : null;
      return { originalCode: code, code: target, error: null, status: 'legacy_exact', includeDescendants: false,
        reason: `${reason}; preserve ${legacyTargets ? 'loaded' : 'ConceptMap'} exact exclusion${target ? '' : ' (no translated target)'}` };
    };
    if (namesPreparation(displayName)) {
      // Candidates must come from the terminology server's VMP/AMP hierarchy.
      const candidates = await findPreparations(displayName);
      const exact = [...new Map(candidates.filter(c => preparationKey(c.display) === preparationKey(displayName))
        .map(c => [c.code, c])).values()];
      if (exact.length === 1) return { originalCode: code, code: exact[0].code, display: exact[0].display, error: null,
        status: 'resolved_family', includeDescendants: true, reason: 'One exact active VMP/AMP preparation match' };
      const inactive = [...new Map((await findInactivePreparations(displayName))
        .filter(c => preparationKey(c.display) === preparationKey(displayName)).map(c => [c.code, c])).values()];
      if (inactive.length === 1) return { originalCode: code, code: inactive[0].code, display: inactive[0].display, error: null,
        status: 'inactive_exact', includeDescendants: true, reason: 'One exact inactive dm+d preparation match; no historical substitution' };
      return legacyExact(`${exact.length} exact active VMP/AMP matches; ${inactive.length} exact inactive dm+d matches; review preparation`);
    }
    if (!translated) return legacyExact('No accepted ConceptMap translation; review exception');
    return { originalCode: code, code: historical[translated.code] || translated.code, display: translated.display, error: null,
      status: 'resolved_family', includeDescendants: true, reason: 'Clinical exception uses accepted ConceptMap translation' };
  }));
}

export function exceptionExclusions(resolutions: ExceptionResolution[]) {
  return {
    descendantCodes: resolutions.flatMap(r => r.code && r.includeDescendants ? [r.code] : []),
    exactCodes: resolutions.flatMap(r => r.code && !r.includeDescendants ? [r.code] : []),
  };
}

export function exceptionError(resolutions: ExceptionResolution[]): string | undefined {
  const errors = resolutions.flatMap(r => r.error ? [r.error] : []);
  return errors.length ? `Quarantined value set. ${errors.join('; ')}` : undefined;
}
