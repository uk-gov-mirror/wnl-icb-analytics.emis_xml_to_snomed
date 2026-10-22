import { SnomedConcept, TranslatedCode } from './types';
import { EXCEPTION_OVERRIDES } from './exception-overrides';

export interface ExceptionResolution {
  additionalCodes?: string[];
  additionalDescendantCodes?: string[];
  additionalExactCodes?: string[];
  overrideVersion?: number;
  originalCode: string;
  code: string | null;
  display?: string;
  error: string | null;
  status: 'resolved_family' | 'inactive_exact' | 'legacy_exact';
  includeDescendants: boolean;
  reason: string;
}

// Used only for metadata when resolution failed, never to authorise descendant subtraction.
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
      form => { forms.push(({ tablets: 'tablet', capsules: 'capsule', ointments: 'ointment', creams: 'cream', drops: 'drop' } as Record<string, string>)[form] || form); return ' '; });
  return `${text.trim().replace(/\s+/g, ' ')}|${forms.sort().join(' ')}`;
}

export async function resolveExceptions(
  exceptions: Array<{ code: string; displayName?: string }>,
  translations: Record<string, TranslatedCode | null>,
  historical: Record<string, string>,
  findPreparations: (name: string) => Promise<SnomedConcept[]>,
  findInactivePreparations: (name: string) => Promise<SnomedConcept[]>,
  legacyTargets?: Record<string, string | null>,
  options: { codeSystem?: string; classifyTarget?: (code: string) => Promise<ExceptionTargetKind>; findExactTarget?: (code: string) => Promise<SnomedConcept[]> } = {},
): Promise<ExceptionResolution[]> {
  const results: ExceptionResolution[] = [];
  for (const { code, displayName = '' } of exceptions) {
    const translated = translations[code];
    const legacyExact = (reason: string): ExceptionResolution => {
      if (legacyTargets && !Object.hasOwn(legacyTargets, code)) throw new Error(`Missing legacy exception target for ${code}`);
      const target = legacyTargets ? legacyTargets[code] : translated ? historical[translated.code] || translated.code : null;
      return { originalCode: code, code: target, error: null, status: 'legacy_exact', includeDescendants: false,
        reason: `${reason}; preserve ${legacyTargets ? 'loaded' : 'ConceptMap'} exact exclusion${target ? '' : ' (no translated target)'}` };
    };
    const override = EXCEPTION_OVERRIDES.find(o => o.emisCode === code);
    if (override) {
      if (preparationKey(displayName) !== preparationKey(override.emisDisplay)) throw new Error(`Override display changed for ${code}`);
      for (const target of override.targets) {
        const found = override.mode === 'inactive_exact' ? await findInactivePreparations(target.display)
          : override.mode === 'dmd_family' ? await findPreparations(target.display)
            : options.findExactTarget ? await options.findExactTarget(target.code) : [];
        if (!found.some(c => c.code === target.code && preparationKey(c.display) === preparationKey(target.display))) {
          throw new Error(`Override ${code} target ${target.code} failed terminology validation`);
        }
        if (override.mode === 'dmd_family' && (!options.classifyTarget || await options.classifyTarget(target.code) !== 'preparation')) {
          throw new Error(`Override ${code} target ${target.code} is not an active dm+d VMP/AMP`);
        }
      }
      for (const target of override.exactTargets || []) {
        const found = options.findExactTarget ? await options.findExactTarget(target.code) : [];
        if (!found.some(c => c.code === target.code && preparationKey(c.display) === preparationKey(target.display))) {
          throw new Error(`Override ${code} exact target ${target.code} failed terminology validation`);
        }
      }
      results.push({ originalCode: code, code: override.targets[0].code,
        additionalCodes: override.targets.slice(1).map(t => t.code),
        additionalExactCodes: override.exactTargets?.map(t => t.code), display: override.targets.map(t => t.display).join('; '),
        error: null, status: override.mode === 'inactive_exact' ? 'inactive_exact' : 'resolved_family',
        includeDescendants: override.mode === 'dmd_family', overrideVersion: override.version,
        reason: `Exception override v${override.version} (${override.mode}): ${override.reason}` });
      continue;
    }
    if (!translated && !/^(SCT_CONST|SCT_PREP|DrugCodeID)$/i.test(options.codeSystem || '')) {
      results.push(legacyExact('No accepted ConceptMap translation; review exception')); continue;
    }
    const target = translated ? historical[translated.code] || translated.code : null;
    // Missing classification is conservative. Production callers always supply the hierarchy lookup.
    const productSystem = /^(SCT_CONST|SCT_PREP|DrugCodeID)$/i.test(options.codeSystem || '');
    const kind = !productSystem && target && options.classifyTarget ? await options.classifyTarget(target) : 'unknown';
    if (!productSystem && kind === 'unknown' && options.classifyTarget) {
      results.push(legacyExact('No current hierarchy establishes the target type; review exception'));
      continue;
    }
    const preparation = productSystem
      || kind === 'ingredient_family' || kind === 'preparation' || kind === 'unknown';
    if (preparation) {
      // Candidates must come from the terminology server's VMP/AMP hierarchy.
      const candidates = await findPreparations(displayName);
      const exact = [...new Map(candidates.filter(c => preparationKey(c.display) === preparationKey(displayName))
        .map(c => [c.code, c])).values()];
      if (exact.length === 1) {
        results.push({ originalCode: code, code: exact[0].code, display: exact[0].display, error: null,
        status: 'resolved_family', includeDescendants: true, reason: 'One exact active VMP/AMP preparation match' });
        continue;
      }
      const inactive = [...new Map((await findInactivePreparations(displayName))
        .filter(c => preparationKey(c.display) === preparationKey(displayName)).map(c => [c.code, c])).values()];
      if (inactive.length === 1) {
        const loaded = legacyTargets ? legacyTargets[code] : target;
        const keepLoaded = loaded && loaded !== inactive[0].code && options.classifyTarget
          && await options.classifyTarget(loaded) === 'preparation';
        const verifiedFamily = !!options.classifyTarget && await options.classifyTarget(inactive[0].code) === 'preparation';
        // A loaded VMP must not widen June's exact exclusion to all its AMPs.
        results.push({ additionalExactCodes: keepLoaded ? [loaded] : [], originalCode: code, code: inactive[0].code, display: inactive[0].display, error: null,
        status: 'inactive_exact', includeDescendants: verifiedFamily, reason: `One exact inactive dm+d preparation match; no historical substitution${verifiedFamily ? '' : '; no verified VMP/AMP ancestry, exact-only'}${keepLoaded ? '; retain loaded product exactly without widening to its AMPs' : ''}` });
        continue;
      }
      results.push(legacyExact(`${exact.length} exact active VMP/AMP matches; ${inactive.length} exact inactive dm+d matches; review preparation`));
      continue;
    }
    if (!translated) { results.push(legacyExact('No accepted ConceptMap translation; review exception')); continue; }
    results.push({ originalCode: code, code: historical[translated.code] || translated.code, display: translated.display, error: null,
      status: 'resolved_family', includeDescendants: true, reason: 'Clinical exception uses accepted ConceptMap translation' });
  }
  return results;
}

export type ExceptionTargetKind = 'preparation' | 'ingredient_family' | 'clinical' | 'unknown';

export function exceptionExclusions(resolutions: ExceptionResolution[]) {
  return {
    descendantCodes: resolutions.flatMap(r => [
      ...(r.code && r.includeDescendants ? [r.code, ...(r.additionalCodes || [])] : []),
      ...(r.additionalDescendantCodes || []),
    ]),
    exactCodes: resolutions.flatMap(r => [
      ...(r.code && !r.includeDescendants ? [r.code, ...(r.additionalCodes || [])] : []),
      ...(r.additionalExactCodes || []),
    ]),
  };
}

export function exceptionError(resolutions: ExceptionResolution[]): string | undefined {
  const errors = resolutions.flatMap(r => r.error ? [r.error] : []);
  return errors.length ? `Quarantined value set. ${errors.join('; ')}` : undefined;
}
