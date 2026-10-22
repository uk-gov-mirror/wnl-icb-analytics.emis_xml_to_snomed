import { SnomedConcept, TranslatedCode } from './types';

export interface ExceptionResolution {
  originalCode: string;
  code: string | null;
  display?: string;
  error: string | null;
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
): Promise<ExceptionResolution[]> {
  return Promise.all(exceptions.map(async ({ code, displayName = '' }) => {
    if (namesPreparation(displayName)) {
      // Candidates must come from the terminology server's VMP/AMP hierarchy.
      const candidates = await findPreparations(displayName);
      const exact = [...new Map(candidates.filter(c => preparationKey(c.display) === preparationKey(displayName))
        .map(c => [c.code, c])).values()];
      if (exact.length === 1) return { originalCode: code, code: exact[0].code, display: exact[0].display, error: null };
      return { originalCode: code, code: null, error: `Preparation exception ${code} (${displayName}) requires reconciliation: ${exact.length} exact VMP/AMP matches` };
    }
    const translated = translations[code];
    if (!translated) return { originalCode: code, code: null, error: `Exception ${code} has no accepted ConceptMap translation` };
    return { originalCode: code, code: historical[translated.code] || translated.code, display: translated.display, error: null };
  }));
}

export function exceptionError(resolutions: ExceptionResolution[]): string | undefined {
  const errors = resolutions.flatMap(r => r.error ? [r.error] : []);
  return errors.length ? `Quarantined value set. ${errors.join('; ')}` : undefined;
}
