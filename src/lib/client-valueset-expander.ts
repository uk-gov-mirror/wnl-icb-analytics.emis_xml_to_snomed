/**
 * Client-side ValueSet expansion for batch extraction.
 *
 * Port of the server's expandSingleValueSet (rawMode): the browser drives the
 * fan-out (SCT_CONST recursive expansion, RF2 refset fallback, 50-code ECL batches) and
 * the server only proxies single bounded terminology calls. This keeps every
 * function invocation short and its response small — no 300s timeout or 4.5MB
 * payload cap in the path — and makes each step individually retryable.
 */

import {
  EmisValueSet,
  RawValueSetExpansion,
  SnomedConcept,
  TranslatedCode,
  EclExpandResponse,
  Rf2RefsetResponse,
  ResolveHistoricalResponse,
} from './types';
import {
  separateRefsets,
  buildBatchedEclQuery,
} from './ecl-builder';
import { expandSctConstProducts } from './sct-const-expander';
import { ExceptionResolution, exceptionError, exceptionExclusions } from './exception-resolver';
import { fetchApi, CancelledError } from './api-client';

interface ValueWithMetadata {
  code: string;
  originalCode: string;
  translatedSnomedCode?: string;
  displayName: string;
  includeChildren: boolean;
  isRefset: boolean;
  codeSystem: string;
}

export interface ExpandOptions {
  isCancelled?: () => boolean;
}

// Each ECL code with << adds ~20-30 chars to the upstream URL; 50 codes stays
// well under typical 8KB URL limits.
const ECL_BATCH_SIZE = 50;
const ECL_PAGE_SIZE = 5000;
const MAX_ECL_PAGES = 100;
const DISPLAY_LOOKUP_CHUNK = 500;

/** Expand an ECL expression fully, paging through the bounded endpoint */
async function expandEcl(ecl: string, options: ExpandOptions): Promise<SnomedConcept[]> {
  const all: SnomedConcept[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_ECL_PAGES; page++) {
    if (options.isCancelled?.()) throw new CancelledError();

    const res = await fetchApi<EclExpandResponse>(
      '/api/terminology/ecl-expand',
      { ecl, offset, count: ECL_PAGE_SIZE },
      { isCancelled: options.isCancelled },
    );

    const concepts = res.concepts || [];
    all.push(...concepts);
    offset += concepts.length;

    if (typeof res.total === 'number' && all.length >= res.total) return all;
    if (typeof res.total !== 'number' && concepts.length < ECL_PAGE_SIZE) return all;
    if (concepts.length === 0) throw new Error('Incomplete terminology expansion: no further page returned');
  }
  throw new Error('Incomplete terminology expansion: page limit reached');
}

/** Resolve display names for codes missing an RF2 description */
async function resolveMissingDisplays(
  codes: string[],
  options: ExpandOptions,
): Promise<Map<string, string>> {
  const displays = new Map<string, string>();

  for (let i = 0; i < codes.length; i += DISPLAY_LOOKUP_CHUNK) {
    if (options.isCancelled?.()) throw new CancelledError();

    const chunk = codes.slice(i, i + DISPLAY_LOOKUP_CHUNK);
    const res = await fetchApi<ResolveHistoricalResponse>(
      '/api/terminology/resolve-historical',
      { conceptIds: chunk },
      { isCancelled: options.isCancelled },
    );

    for (const [code, resolution] of Object.entries(res.resolutions || {})) {
      if (resolution.display) displays.set(code, resolution.display);
    }
  }

  return displays;
}

export async function expandValueSetClientSide(
  vs: EmisValueSet,
  translations: Record<string, TranslatedCode | null>,
  historical: Record<string, string>,
  options: ExpandOptions = {},
): Promise<RawValueSetExpansion> {
  const exceptionResolutions = vs.exceptions?.length
    ? (await fetchApi<{ resolutions: ExceptionResolution[] }>('/api/terminology/resolve-exceptions',
      { exceptions: vs.exceptions, translations, historical, codeSystem: vs.codeSystem }, { isCancelled: options.isCancelled })).resolutions
    : [];
  const expansionError = exceptionError(exceptionResolutions);
  if (expansionError) return {
    concepts: [], parentCodes: [], rf2RefsetIds: [], successfulSctConstCodes: [],
    sctConstNoProducts: {}, exceptionResolutions, expansionError,
  };
  const { descendantCodes: excludedCodes, exactCodes } = exceptionExclusions(exceptionResolutions);
  const excludedSet = new Set([...excludedCodes, ...exactCodes]);

  // Build values with translated/resolved codes
  const vsValues: ValueWithMetadata[] = vs.values.map((v) => {
    const translated = translations[v.code];
    const snomedCode = translated?.code || v.code;
    const currentCode = historical[snomedCode] || snomedCode;

    return {
      code: currentCode,
      originalCode: v.code,
      translatedSnomedCode: translated?.code,
      displayName: v.displayName || '',
      includeChildren: v.includeChildren || false,
      isRefset: v.isRefset || false,
      codeSystem: vs.codeSystem || 'EMISINTERNAL',
    };
  });

  // === SCT_CONST codes: recursive UK Product expansion per substance ===
  const sctConstCodes = vsValues.filter((v) => v.codeSystem === 'SCT_CONST');
  const ukProductConcepts: SnomedConcept[] = [];
  const successfulSctConstCodes = new Set<string>();
  const sctConstNoProducts = new Map<string, { substanceCode: string; displayName: string }>();

  for (const sctConstValue of sctConstCodes) {
    if (options.isCancelled?.()) throw new CancelledError();

    if (!sctConstValue.translatedSnomedCode) {
      sctConstNoProducts.set(sctConstValue.originalCode, {
        substanceCode: sctConstValue.originalCode,
        displayName: sctConstValue.displayName || sctConstValue.originalCode,
      });
      continue;
    }

    const substanceCode = sctConstValue.translatedSnomedCode;

    const { products } = await expandSctConstProducts(
      substanceCode, excludedCodes, (ecl) => expandEcl(ecl, options), exactCodes,
    );

    if (products.length > 0) {
      successfulSctConstCodes.add(sctConstValue.originalCode);
    } else {
      sctConstNoProducts.set(sctConstValue.originalCode, {
        substanceCode,
        displayName: sctConstValue.displayName || substanceCode,
      });
    }

    for (const product of products) {
      ukProductConcepts.push({
        ...product,
        source: 'terminology_server',
        excludeChildren: !sctConstValue.includeChildren,
      });
    }
  }

  // === Refsets: RF2 first, ECL fallback ===
  const nonSctConstValues = vsValues.filter((v) => v.codeSystem !== 'SCT_CONST');
  const { refsets: refsetValues, nonRefsets: nonRefsetValues } = separateRefsets(nonSctConstValues);

  // Codes that failed ConceptMap translation may still be refsets in RF2
  const codesThatFailedConceptMap = nonSctConstValues.filter(
    (v) => !translations[v.originalCode] && !v.isRefset,
  ) as ValueWithMetadata[];

  const rf2Candidates = new Set<string>();
  refsetValues.forEach((v) => rf2Candidates.add(v.code));
  codesThatFailedConceptMap.forEach((v) => {
    if (v.code) rf2Candidates.add(v.code);
    if (v.originalCode) rf2Candidates.add(v.originalCode);
  });

  let rf2Found: NonNullable<Rf2RefsetResponse['refsets']> = {};
  if (rf2Candidates.size > 0) {
    const res = await fetchApi<Rf2RefsetResponse>(
      '/api/terminology/rf2-refset',
      { refsetIds: Array.from(rf2Candidates) },
      { isCancelled: options.isCancelled },
    );
    rf2Found = res.refsets || {};
  }

  const potentialRefsetsFromRf2: ValueWithMetadata[] = [];
  for (const value of codesThatFailedConceptMap) {
    const codeInRf2 = [value.code, value.originalCode].filter(Boolean).find((c) => rf2Found[c]);
    if (codeInRf2) {
      potentialRefsetsFromRf2.push({ ...value, code: codeInRf2, isRefset: true });
    }
  }

  const allRefsetValues = [...(refsetValues as ValueWithMetadata[]), ...potentialRefsetsFromRf2];
  const allNonRefsetValues = (nonRefsetValues as ValueWithMetadata[]).filter(
    (v) => !potentialRefsetsFromRf2.some((pr) => pr.code === v.code || pr.originalCode === v.code),
  );

  const vsConcepts: SnomedConcept[] = [];
  const rf2RefsetIds: string[] = [];

  for (const refsetValue of allRefsetValues) {
    const found = rf2Found[refsetValue.code];
    if (!found) continue;
    rf2RefsetIds.push(refsetValue.code);
    for (const member of found.members) {
      vsConcepts.push({
        code: member.code,
        display: member.display,
        system: 'http://snomed.info/sct',
        source: 'rf2_file',
      });
    }
  }

  // Fill display names missing from RF2 descriptions via the terminology server
  const missingDisplayCodes = vsConcepts.filter((c) => !c.display).map((c) => c.code);
  if (missingDisplayCodes.length > 0) {
    const displays = await resolveMissingDisplays(missingDisplayCodes, options);
    for (const concept of vsConcepts) {
      if (!concept.display) concept.display = displays.get(concept.code) || '';
    }
  }

  // === Remaining codes via batched ECL ===
  const refsetsToQueryViaEcl = allRefsetValues.filter((v) => !rf2Found[v.code]);

  // Only send codes that are translated, refsets, or already SNOMED — never raw
  // EMISINTERNAL codes like "A"/"M"/"F"
  const isSuccessfullyMapped = (v: ValueWithMetadata): boolean => {
    const hasTranslation = !!translations[v.originalCode];
    const isRefsetCode = v.isRefset || rf2RefsetIds.includes(v.code);
    const isAlreadySnomed = v.codeSystem === 'SNOMED_CONCEPT';
    return hasTranslation || isRefsetCode || isAlreadySnomed;
  };

  const valuesForEcl = [...allNonRefsetValues, ...refsetsToQueryViaEcl].filter(isSuccessfullyMapped);

  for (let i = 0; i < valuesForEcl.length; i += ECL_BATCH_SIZE) {
    if (options.isCancelled?.()) throw new CancelledError();

    const batch = valuesForEcl.slice(i, i + ECL_BATCH_SIZE);
    const ecl = buildBatchedEclQuery(batch, excludedCodes, undefined, exactCodes);
    if (!ecl) continue;

    const batchConcepts = await expandEcl(ecl, options);
    vsConcepts.push(...batchConcepts);
  }

  // Combine with UK Product concepts
  const combined = [...vsConcepts, ...ukProductConcepts];
  // RF2 members bypass ECL MINUS. Apply complete exclusions after every branch.
  for (let i = 0; i < excludedCodes.length; i += ECL_BATCH_SIZE) {
    const excluded = await expandEcl(excludedCodes.slice(i, i + ECL_BATCH_SIZE).map(c => `<< ${c}`).join(' OR '), options);
    excluded.forEach(c => excludedSet.add(c.code));
  }

  // Mark parent codes (preserve source from RF2 or terminology server)
  const parentCodeSet = new Set(vsValues.map((v) => v.code));
  for (const concept of combined) {
    if (parentCodeSet.has(concept.code)) {
      const value = vsValues.find((v) => v.code === concept.code);
      if (value) {
        concept.isRefset = value.isRefset;
        concept.excludeChildren = !value.includeChildren;
      }
    }
  }

  // Filter exclusions, then dedupe by code (ECL batches can overlap on shared descendants)
  const seen = new Set<string>();
  const filteredConcepts = combined.filter((c) => {
    if (excludedSet.has(c.code) || seen.has(c.code)) return false;
    seen.add(c.code);
    return true;
  });

  return {
    exceptionResolutions,
    concepts: filteredConcepts,
    parentCodes: vsValues.map((v) => v.code),
    rf2RefsetIds,
    successfulSctConstCodes: Array.from(successfulSctConstCodes),
    sctConstNoProducts: Object.fromEntries(sctConstNoProducts),
  };
}
