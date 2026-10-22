import { getAccessToken } from './oauth-client';
import { FhirValueSetExpansion, SnomedConcept, ConceptMapTranslateResponse, TranslatedCode, EquivalenceFilter } from './types';
import { getPrimaryConceptMapId, getFallbackConceptMapId, getConceptMapVersions as _getConceptMapVersions } from './concept-map-resolver';
import { handleFhirResponse } from './fhir-error-handler';
import { withRetry, isRetryableStatus, sequentialWithDelay } from './concurrency';

const TERMINOLOGY_SERVER_BASE =
  process.env.TERMINOLOGY_SERVER ||
  'https://ontology.onelondon.online/production1/fhir';

const EMIS_CODE_SYSTEM = 'http://LDS.nhs/EMIS/CodeID/cs';
const SNOMED_CODE_SYSTEM = 'http://snomed.info/sct';

/** Page name searches even when the server caps the requested page size. */
async function searchPreparations(name: string, active: boolean): Promise<SnomedConcept[]> {
  const token = await getAccessToken();
  const url = new URL(`${TERMINOLOGY_SERVER_BASE}/ValueSet/$expand`);
  url.searchParams.set('url', active
    ? 'http://snomed.info/sct?fhir_vs=ecl/(<10363801000001108 OR <10363901000001102)'
    : 'http://snomed.info/sct?fhir_vs');
  url.searchParams.set('filter', name.match(/^[a-z][a-z-]*/i)?.[0] || name);
  url.searchParams.set('activeOnly', String(active));
  url.searchParams.set('count', '1000');
  const candidates: SnomedConcept[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    if (offset || !active) url.searchParams.set('offset', String(offset));
    const data = await withRetry(async () => {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
      if (isRetryableStatus(response.status)) throw new Error(`Terminology server returned ${response.status}`);
      await handleFhirResponse(response, { context: 'resolving preparation exception' });
      return await response.json() as FhirValueSetExpansion;
    }, { context: 'Preparation search' });
    const rows = data.expansion?.contains || [];
    for (const row of rows) {
      if (seen.has(row.code)) throw new Error('Preparation search repeated a concept; offset may be ignored');
      seen.add(row.code);
      if (active || (row.inactive === true && /^\d+100000110\d$/.test(row.code))) candidates.push({ ...row, source: 'terminology_server' });
    }
    offset += rows.length;
    if (typeof data.expansion?.total === 'number' ? offset >= data.expansion.total : rows.length < 1000) return candidates;
    if (!rows.length) break;
  }
  throw new Error('Preparation search is incomplete; reconcile the exception');
}

export const findPreparationCandidates = (name: string) => searchPreparations(name, true);
export const findInactivePreparationCandidates = (name: string) => searchPreparations(name, false);

/** VMP/AMP membership takes precedence: both also descend from VTM and medicinal product. */
export async function classifyExceptionTarget(code: string): Promise<import('./exception-resolver').ExceptionTargetKind> {
  if (!/^\d+$/.test(code)) throw new Error('Invalid exception target');
  if (code === '10363801000001108' || code === '10363901000001102') return 'ingredient_family';
  const ancestors = new Set((await expandEclQuery(`>> ${code}`)).map(c => c.code));
  if (!ancestors.has(code) || !ancestors.has('138875005')) return 'unknown';
  if (ancestors.has('10363801000001108') || ancestors.has('10363901000001102')) return 'preparation';
  return ancestors.has('105590001') || ancestors.has('373873005') ? 'ingredient_family' : 'clinical';
}

// Default: Only accept equivalent or narrower mappings
const ACCEPTED_EQUIVALENCES = ['equivalent', 'narrower'];

/**
 * Gets the list of accepted equivalences based on the filter setting
 */
function getAcceptedEquivalences(filter: EquivalenceFilter): string[] {
  switch (filter) {
    case 'strict':
      return ['equivalent', 'narrower'];
    case 'with-broader':
      return ['equivalent', 'narrower', 'broader'];
    case 'with-related':
      return ['equivalent', 'narrower', 'related-to'];
    case 'all':
      return ['equivalent', 'narrower', 'broader', 'related-to', 'inexact'];
    default:
      return ['equivalent', 'narrower'];
  }
}

/**
 * Re-export ConceptMap versions for convenience
 */
export function getConceptMapVersions() {
  return _getConceptMapVersions();
}

/**
 * Attempts translation using a specific ConceptMap ID
 * Returns the translated code if successful, null otherwise
 * Includes retry logic for transient server errors (502, 503, 504, 429)
 */
async function tryConceptMapTranslation(
  emisCode: string,
  conceptMapId: string,
  token: string,
  acceptedEquivalences: string[],
  equivalences?: Record<string, string>
): Promise<TranslatedCode | null> {
  const url = `${TERMINOLOGY_SERVER_BASE}/ConceptMap/${conceptMapId}/$translate`;

  try {
    return await withRetry(async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/fhir+json; charset=utf-8',
          'Content-Type': 'application/fhir+json; charset=utf-8',
        },
        body: JSON.stringify({
          resourceType: 'Parameters',
          parameter: [
            { name: 'code', valueCode: emisCode },
            { name: 'system', valueUri: EMIS_CODE_SYSTEM },
            { name: 'target', valueUri: SNOMED_CODE_SYSTEM },
          ],
        }),
        signal: AbortSignal.timeout(10000),
      });

      // Check for retryable HTTP status codes before processing
      if (isRetryableStatus(response.status)) {
        throw new Error(
          `Terminology server returned ${response.status}: Server overloaded or rate limited.`
        );
      }

      // Handle errors - only 404 should try fallback, other errors should throw
      const errorResult = await handleFhirResponse(response, {
        overrides: { 404: 'RETURN_NULL' },
        context: `translating code ${emisCode} via ConceptMap ${conceptMapId}`
      });

      if (errorResult !== null) {
        return null; // 404 - try fallback ConceptMap
      }

      // Safely parse JSON
      let data: ConceptMapTranslateResponse;
      try {
        const responseText = await response.text();
        if (!responseText.trim().startsWith('{')) {
          console.warn(`ConceptMap translation returned non-JSON for ${emisCode}:`, responseText.substring(0, 200));
          return null;
        }
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.warn(`Failed to parse ConceptMap response for ${emisCode}:`, parseError);
        return null;
      }

      // Extract the first match from the translation result
      if (data.parameter) {
        const resultParam = data.parameter.find((p) => p.name === 'result');
        if (resultParam?.valueBoolean) {
          const matchParam = data.parameter.find((p) => p.name === 'match');
          if (matchParam?.part) {
            const equivalencePart = matchParam.part.find((p) => p.name === 'equivalence');
            const equivalence = equivalencePart?.valueCode || equivalencePart?.valueString;
            if (equivalence && equivalences && !equivalences[emisCode]) equivalences[emisCode] = equivalence;

            if (equivalence && !acceptedEquivalences.includes(equivalence)) {
              return null; // Rejected due to equivalence filter
            }

            const conceptPart = matchParam.part.find((p) => p.name === 'concept');
            if (conceptPart?.valueCoding?.code) {
              return {
                code: conceptPart.valueCoding.code,
                display: conceptPart.valueCoding.display,
                equivalence,
              };
            }
          }
        }
      }

      return null;
    }, {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 15000,
      context: `ConceptMap translation for ${emisCode}`
    });
  } catch (error) {
    console.warn(`Error translating EMIS code ${emisCode} with ConceptMap ${conceptMapId}:`, error);
    return null;
  }
}

/**
 * Translates a single EMIS code to SNOMED using ConceptMap
 * Tries the main ConceptMap first, then falls back to the DrugCodeID ConceptMap if the main one fails
 * Accepts mappings based on the equivalence filter setting
 */
export async function translateEmisCodeToSnomed(
  emisCode: string,
  equivalenceFilter: EquivalenceFilter = 'strict',
  equivalences?: Record<string, string>
): Promise<TranslatedCode | null> {
  const token = await getAccessToken();
  const acceptedEquivalences = getAcceptedEquivalences(equivalenceFilter);

  // Resolve latest ConceptMap IDs on first call
  const primaryId = await getPrimaryConceptMapId(token);
  const fallbackId = await getFallbackConceptMapId(token);

  // Try main ConceptMap first
  const result = await tryConceptMapTranslation(emisCode, primaryId, token, acceptedEquivalences, equivalences);
  if (result) {
    return result;
  }

  // If main ConceptMap failed (non-404 error) or returned no match, try fallback
  console.log(`Trying fallback ConceptMap for EMIS code ${emisCode}...`);
  const fallbackResult = await tryConceptMapTranslation(emisCode, fallbackId, token, acceptedEquivalences, equivalences);
  if (fallbackResult) {
    console.log(`Fallback ConceptMap succeeded for EMIS code ${emisCode}`);
    return fallbackResult;
  }

  return null;
}

/**
 * Batch translates EMIS codes to SNOMED using ConceptMap
 * Accepts mappings based on the equivalence filter setting
 * Returns a map of EMIS code -> TranslatedCode (with display name)
 *
 * Processes codes sequentially with 10ms delay to avoid overwhelming the terminology server
 */
export async function translateEmisCodesToSnomed(
  emisCodes: string[],
  equivalenceFilter: EquivalenceFilter = 'strict',
  equivalences?: Record<string, string>
): Promise<Map<string, TranslatedCode>> {
  const mapping = new Map<string, TranslatedCode>();
  const uniqueCodes = [...new Set(emisCodes)];
  const acceptedEquivalences = getAcceptedEquivalences(equivalenceFilter);

  console.log(`Translating ${uniqueCodes.length} unique EMIS codes to SNOMED (filter: ${equivalenceFilter}, accepting: ${acceptedEquivalences.join(', ')})...`);

  let successCount = 0;
  let failureCount = 0;

  await sequentialWithDelay(uniqueCodes, async (emisCode) => {
    const translatedCode = await translateEmisCodeToSnomed(emisCode, equivalenceFilter, equivalences);
    if (equivalences && !equivalences[emisCode]) equivalences[emisCode] = 'unmapped';
    if (translatedCode) {
      mapping.set(emisCode, translatedCode);
      successCount++;
    } else {
      failureCount++;
    }
  }, 10);

  console.log(`ConceptMap translation complete: ${successCount} successful, ${failureCount} failed/rejected (equivalence filter: ${equivalenceFilter}, accepted: ${acceptedEquivalences.join(', ')})`);

  if (mapping.size < uniqueCodes.length) {
    const missing = uniqueCodes.filter(code => !mapping.has(code));
    if (missing.length <= 10) {
      console.warn(`Failed to translate EMIS codes: ${missing.join(', ')}`);
    } else {
      console.warn(`Failed to translate ${missing.length} EMIS codes (first 10): ${missing.slice(0, 10).join(', ')}...`);
    }
  }

  return mapping;
}

/**
 * Checks if a SNOMED concept is inactive and resolves to current concept if historical
 * Returns the current concept ID or the original if still active
 * Includes retry logic for transient server errors (502, 503, 504, 429)
 */
export async function resolveHistoricalConcept(
  conceptId: string
): Promise<{ currentConceptId: string; isHistorical: boolean; display?: string }> {
  const token = await getAccessToken();
  const url = `${TERMINOLOGY_SERVER_BASE}/CodeSystem/$lookup`;

  try {
    return await withRetry(async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/fhir+json; charset=utf-8',
          'Content-Type': 'application/fhir+json; charset=utf-8',
        },
        body: JSON.stringify({
          resourceType: 'Parameters',
          parameter: [
            { name: 'system', valueUri: SNOMED_CODE_SYSTEM },
            { name: 'code', valueCode: conceptId },
            { name: 'property', valueCode: 'inactive' },
            { name: 'property', valueCode: 'SAME_AS' },
            { name: 'property', valueCode: 'REPLACED_BY' },
            { name: 'property', valueCode: 'POSSIBLY_EQUIVALENT_TO' },
          ],
        }),
        signal: AbortSignal.timeout(10000),
      });

      // Check for retryable HTTP status codes before processing
      if (isRetryableStatus(response.status)) {
        throw new Error(
          `Terminology server returned ${response.status}: Server overloaded or rate limited.`
        );
      }

      // Handle errors - 404 returns null (concept not found), other errors should throw
      const errorResult = await handleFhirResponse(response, {
        overrides: { 404: 'RETURN_NULL' },
        context: `looking up historical concept ${conceptId}`
      });

      if (errorResult !== null) {
        return { currentConceptId: conceptId, isHistorical: false };
      }

      // Safely parse JSON
      let data: any;
      try {
        const responseText = await response.text();
        if (!responseText.trim().startsWith('{')) {
          console.warn(`Historical concept lookup returned non-JSON for ${conceptId}:`, responseText.substring(0, 200));
          return { currentConceptId: conceptId, isHistorical: false };
        }
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.warn(`Failed to parse historical concept response for ${conceptId}:`, parseError);
        return { currentConceptId: conceptId, isHistorical: false };
      }

      // Extract display name
      let display: string | undefined;
      const displayParam = data.parameter?.find((p: any) => p.name === 'display');
      if (displayParam?.valueString) {
        display = displayParam.valueString;
      }

      // Check if concept is inactive
      let isInactive = false;
      if (data.parameter) {
        const inactiveProperty = data.parameter.find(
          (p: any) => p.name === 'property' && p.part?.some((part: any) => part.name === 'code' && part.valueCode === 'inactive')
        );
        if (inactiveProperty?.part) {
          const valuePart = inactiveProperty.part.find((p: any) => p.name === 'value');
          isInactive = valuePart?.valueBoolean === true;
        }
      }

      if (!isInactive) {
        return { currentConceptId: conceptId, isHistorical: false, display };
      }

      // Concept is inactive - look for historical associations in priority order
      const associationPriority = ['SAME_AS', 'REPLACED_BY', 'POSSIBLY_EQUIVALENT_TO'];

      for (const associationType of associationPriority) {
        if (data.parameter) {
          const associationProperty = data.parameter.find(
            (p: any) => p.name === 'property' && p.part?.some((part: any) => part.name === 'code' && part.valueCode === associationType)
          );
          if (associationProperty?.part) {
            const valuePart = associationProperty.part.find((p: any) => p.name === 'value');
            if (valuePart?.valueCode) {
              console.log(`Resolved historical concept ${conceptId} -> ${valuePart.valueCode} (${associationType})`);
              return { currentConceptId: valuePart.valueCode, isHistorical: true, display };
            }
          }
        }
      }

      console.warn(`Concept ${conceptId} is inactive but has no historical association`);
      return { currentConceptId: conceptId, isHistorical: true, display };
    }, {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 15000,
      context: `historical concept lookup for ${conceptId}`
    });
  } catch (error) {
    console.error(`Error resolving historical concept ${conceptId}:`, error);
    return { currentConceptId: conceptId, isHistorical: false };
  }
}

/**
 * Batch resolves historical concepts to current concepts
 * Returns a map of original concept ID -> current concept ID
 *
 * Processes concepts sequentially with 10ms delay to avoid overwhelming the terminology server
 */
export async function resolveHistoricalConcepts(
  conceptIds: string[]
): Promise<Map<string, string>> {
  const mapping = new Map<string, string>();
  const uniqueIds = [...new Set(conceptIds)];

  console.log(`Checking ${uniqueIds.length} concepts for historical associations...`);

  let historicalCount = 0;

  await sequentialWithDelay(uniqueIds, async (conceptId) => {
    const result = await resolveHistoricalConcept(conceptId);
    mapping.set(conceptId, result.currentConceptId);
    if (result.isHistorical) {
      historicalCount++;
    }
  }, 10);

  console.log(`Historical resolution complete: ${historicalCount} historical concepts updated`);

  return mapping;
}

/**
 * Parse a single ConceptMap $translate response entry and extract the translated code.
 * Reuses the same logic as tryConceptMapTranslation.
 */
export function parseTranslateResponse(
  data: ConceptMapTranslateResponse,
  acceptedEquivalences?: string[]
): TranslatedCode | null {
  if (!data.parameter) return null;
  const resultParam = data.parameter.find((p) => p.name === 'result');
  if (!resultParam?.valueBoolean) return null;
  const matchParam = data.parameter.find((p) => p.name === 'match');
  if (!matchParam?.part) return null;

  const equivalencePart = matchParam.part.find((p) => p.name === 'equivalence');
  const equivalence = equivalencePart?.valueCode || equivalencePart?.valueString;
  if (equivalence && acceptedEquivalences && !acceptedEquivalences.includes(equivalence)) return null;

  const conceptPart = matchParam.part.find((p) => p.name === 'concept');
  if (!conceptPart?.valueCoding?.code) return null;

  return {
    code: conceptPart.valueCoding.code,
    display: conceptPart.valueCoding.display,
    equivalence,
  };
}

function checkTranslationEntry(entry: any): void {
  const status = entry?.response?.status;
  if (status?.startsWith('404')) return;
  if (!status?.startsWith('2') || !entry.resource?.parameter) {
    throw new Error(`Incomplete ConceptMap translation response (${status || 'missing entry'})`);
  }
}

/**
 * Batch translate EMIS codes using a FHIR Bundle.
 * Sends one HTTP request for up to ~500 codes instead of one request per code.
 * Tries the primary ConceptMap first, then falls back for codes that didn't match.
 */
export async function batchTranslateEmisCodes(
  emisCodes: string[],
  equivalenceFilter: EquivalenceFilter = 'strict',
  equivalences: Record<string, string> = {}
): Promise<Record<string, TranslatedCode | null>> {
  if (emisCodes.length === 0) return {};

  const token = await getAccessToken();
  const acceptedEquivalences = getAcceptedEquivalences(equivalenceFilter);
  const primaryId = await getPrimaryConceptMapId(token);
  const fallbackId = await getFallbackConceptMapId(token);

  const results: Record<string, TranslatedCode | null> = {};

  // Build FHIR batch bundle for primary ConceptMap
  const buildTranslateBundle = (codes: string[], conceptMapId: string) => ({
    resourceType: 'Bundle',
    type: 'batch',
    entry: codes.map(code => ({
      request: {
        method: 'POST',
        url: `ConceptMap/${conceptMapId}/$translate`,
      },
      resource: {
        resourceType: 'Parameters',
        parameter: [
          { name: 'code', valueCode: code },
          { name: 'system', valueUri: EMIS_CODE_SYSTEM },
          { name: 'target', valueUri: SNOMED_CODE_SYSTEM },
        ],
      },
    })),
  });

  const sendBundle = async (bundle: any): Promise<any> => {
    const response = await fetch(TERMINOLOGY_SERVER_BASE, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/fhir+json; charset=utf-8',
        'Content-Type': 'application/fhir+json; charset=utf-8',
      },
      body: JSON.stringify(bundle),
      signal: AbortSignal.timeout(120000), // 2 min for large batches
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`FHIR batch request failed (${response.status}): ${text.substring(0, 300)}`);
    }
    return response.json();
  };

  // Phase 1: Try primary ConceptMap
  console.log(`Batch translating ${emisCodes.length} codes via primary ConceptMap ${primaryId}...`);
  const primaryBundle = buildTranslateBundle(emisCodes, primaryId);
  const primaryResponse = await sendBundle(primaryBundle);

  const failedCodes: string[] = [];
  if (primaryResponse.entry) {
    for (let i = 0; i < emisCodes.length; i++) {
      const entry = primaryResponse.entry[i];
      checkTranslationEntry(entry);
      if (entry?.response?.status?.startsWith('2') && entry.resource) {
        const unfiltered = parseTranslateResponse(entry.resource);
        if (unfiltered?.equivalence) equivalences[emisCodes[i]] = unfiltered.equivalence;
        const translated = parseTranslateResponse(entry.resource, acceptedEquivalences);
        if (translated) {
          results[emisCodes[i]] = translated;
          continue;
        }
      }
      // Not found or error — try fallback
      failedCodes.push(emisCodes[i]);
    }
  } else {
    throw new Error('Incomplete primary ConceptMap batch response');
  }

  console.log(`Primary ConceptMap: ${emisCodes.length - failedCodes.length} translated, ${failedCodes.length} need fallback`);

  // Phase 2: Try fallback ConceptMap for codes that didn't match
  if (failedCodes.length > 0) {
    console.log(`Batch translating ${failedCodes.length} codes via fallback ConceptMap ${fallbackId}...`);
    const fallbackBundle = buildTranslateBundle(failedCodes, fallbackId);
    const fallbackResponse = await sendBundle(fallbackBundle);

    if (fallbackResponse.entry) {
      for (let i = 0; i < failedCodes.length; i++) {
        const entry = fallbackResponse.entry[i];
        checkTranslationEntry(entry);
        if (entry?.response?.status?.startsWith('2') && entry.resource) {
          const unfiltered = parseTranslateResponse(entry.resource);
          if (unfiltered?.equivalence && !equivalences[failedCodes[i]]) equivalences[failedCodes[i]] = unfiltered.equivalence;
          const translated = parseTranslateResponse(entry.resource, acceptedEquivalences);
          if (translated) {
            results[failedCodes[i]] = translated;
            continue;
          }
        }
        // Still no match
        results[failedCodes[i]] = null;
      }
    } else {
      throw new Error('Incomplete fallback ConceptMap batch response');
    }
  }

  for (const code of emisCodes) equivalences[code] ||= 'unmapped';
  const successCount = Object.values(results).filter(v => v !== null).length;
  console.log(`Batch translation complete: ${successCount}/${emisCodes.length} translated`);
  return results;
}

/**
 * Batch resolve historical concepts using a FHIR Bundle.
 * Sends one HTTP request for up to ~500 concepts instead of one per concept.
 */
export async function batchResolveHistorical(
  conceptIds: string[]
): Promise<Record<string, { currentConceptId: string; isHistorical: boolean; display?: string }>> {
  if (conceptIds.length === 0) return {};

  const token = await getAccessToken();
  const results: Record<string, { currentConceptId: string; isHistorical: boolean; display?: string }> = {};

  // Build FHIR batch bundle for $lookup
  const bundle = {
    resourceType: 'Bundle',
    type: 'batch',
    entry: conceptIds.map(conceptId => ({
      request: {
        method: 'POST',
        url: 'CodeSystem/$lookup',
      },
      resource: {
        resourceType: 'Parameters',
        parameter: [
          { name: 'system', valueUri: SNOMED_CODE_SYSTEM },
          { name: 'code', valueCode: conceptId },
          { name: 'property', valueCode: 'inactive' },
          { name: 'property', valueCode: 'SAME_AS' },
          { name: 'property', valueCode: 'REPLACED_BY' },
          { name: 'property', valueCode: 'POSSIBLY_EQUIVALENT_TO' },
        ],
      },
    })),
  };

  const response = await fetch(TERMINOLOGY_SERVER_BASE, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/fhir+json; charset=utf-8',
      'Content-Type': 'application/fhir+json; charset=utf-8',
    },
    body: JSON.stringify(bundle),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`FHIR batch lookup failed (${response.status}): ${text.substring(0, 300)}`);
  }

  const responseBundle = await response.json();
  const associationPriority = ['SAME_AS', 'REPLACED_BY', 'POSSIBLY_EQUIVALENT_TO'];

  if (responseBundle.entry) {
    for (let i = 0; i < conceptIds.length; i++) {
      const conceptId = conceptIds[i];
      const entry = responseBundle.entry[i];

      if (!entry?.response?.status?.startsWith('2') || !entry.resource?.parameter) {
        results[conceptId] = { currentConceptId: conceptId, isHistorical: false };
        continue;
      }

      const data = entry.resource;

      // Extract display
      const displayParam = data.parameter.find((p: any) => p.name === 'display');
      const display = displayParam?.valueString;

      // Check inactive
      let isInactive = false;
      const inactiveProp = data.parameter.find(
        (p: any) => p.name === 'property' && p.part?.some((part: any) => part.name === 'code' && part.valueCode === 'inactive')
      );
      if (inactiveProp?.part) {
        const valuePart = inactiveProp.part.find((p: any) => p.name === 'value');
        isInactive = valuePart?.valueBoolean === true;
      }

      if (!isInactive) {
        results[conceptId] = { currentConceptId: conceptId, isHistorical: false, display };
        continue;
      }

      // Find historical association
      let resolved = false;
      for (const assocType of associationPriority) {
        const assocProp = data.parameter.find(
          (p: any) => p.name === 'property' && p.part?.some((part: any) => part.name === 'code' && part.valueCode === assocType)
        );
        if (assocProp?.part) {
          const valuePart = assocProp.part.find((p: any) => p.name === 'value');
          if (valuePart?.valueCode) {
            results[conceptId] = { currentConceptId: valuePart.valueCode, isHistorical: true, display };
            resolved = true;
            break;
          }
        }
      }

      if (!resolved) {
        results[conceptId] = { currentConceptId: conceptId, isHistorical: true, display };
      }
    }
  } else {
    for (const conceptId of conceptIds) {
      results[conceptId] = { currentConceptId: conceptId, isHistorical: false };
    }
  }

  const historicalCount = Object.values(results).filter(r => r.isHistorical).length;
  console.log(`Batch historical resolution: ${historicalCount}/${conceptIds.length} historical`);
  return results;
}

/**
 * Expands one page of an ECL query via ValueSet/$expand with count/offset.
 * Single upstream call (plus retries) — bounded duration and response size,
 * suitable for serverless invocation.
 */
export async function expandEclPage(
  eclExpression: string,
  offset: number,
  count: number,
  maxRetries: number = 3
): Promise<{ concepts: SnomedConcept[]; total: number }> {
  // Handle empty ECL expression
  if (!eclExpression || eclExpression.trim() === '') {
    console.warn('Empty ECL expression provided - returning empty result');
    return { concepts: [], total: 0 };
  }

  const token = await getAccessToken();

  // URL encode the ECL expression
  const encodedEcl = encodeURIComponent(eclExpression);
  const url = `${TERMINOLOGY_SERVER_BASE}/ValueSet/$expand`;

  // Construct the URL parameter: http://snomed.info/sct?fhir_vs=ecl/{encoded_ecl}
  const urlParam = `http://snomed.info/sct?fhir_vs=ecl/${encodedEcl}`;
  const fullUrl = `${url}?url=${encodeURIComponent(urlParam)}&count=${count}&offset=${offset}`;

  // Wrap the fetch in retry logic for transient server errors (502, 503, 504, 429)
  return withRetry(async () => {
    let response: Response;
    try {
      response = await fetch(fullUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/fhir+json; charset=utf-8',
        },
        signal: AbortSignal.timeout(30000), // 30 second timeout
      });
    } catch (error: any) {
      // Handle network errors (fetch failures, timeouts, etc.)
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new Error(
          `Request timeout (30s): The terminology server did not respond in time. The server may be overloaded.`
        );
      }
      if (error?.message?.includes('fetch') || error?.message?.includes('network')) {
        throw new Error(
          `Network error: Unable to connect to terminology server. Please check your internet connection.`
        );
      }
      throw new Error(
        `Network error connecting to terminology server: ${error?.message || 'Unknown error'}`
      );
    }

    // Check for retryable HTTP status codes before processing
    if (isRetryableStatus(response.status)) {
      throw new Error(
        `Terminology server returned ${response.status}: Server overloaded or rate limited.`
      );
    }

    // Handle FHIR errors - 404 returns empty array for this operation
    const errorResult = await handleFhirResponse(response, {
      overrides: { 404: 'RETURN_EMPTY' },
      context: 'expanding ValueSet'
    });

    if (errorResult !== null) {
      return { concepts: [], total: 0 }; // 404 - code not found
    }

    // Safely parse JSON with better error handling
    let data: FhirValueSetExpansion;
    try {
      const responseText = await response.text();

      // Check if response looks like JSON
      if (!responseText.trim().startsWith('{') && !responseText.trim().startsWith('[')) {
        console.error('Terminology server returned non-JSON response:', {
          status: response.status,
          contentType: response.headers.get('content-type'),
          bodyPreview: responseText.substring(0, 500),
        });
        throw new Error(
          `Terminology server returned unexpected response (not JSON). ` +
          `Status: ${response.status}. This may indicate server overload or a proxy error.`
        );
      }

      data = JSON.parse(responseText);
    } catch (parseError: any) {
      if (parseError.message?.includes('not JSON') || parseError.message?.includes('unexpected response')) {
        throw parseError;
      }
      console.error('Failed to parse terminology server response as JSON:', parseError);
      throw new Error(
        `Failed to parse terminology server response: ${parseError.message}. ` +
        `The server may be returning an error page or rate limiting response.`
      );
    }

    // Extract concepts
    const concepts: SnomedConcept[] = [];
    if (data.expansion?.contains) {
      for (const item of data.expansion.contains) {
        concepts.push({
          code: item.code,
          display: item.display,
          system: item.system,
          source: 'child',
        });
      }
    }

    // expansion.total is the full match count across all pages
    const total = typeof data.expansion?.total === 'number' ? data.expansion.total : concepts.length;

    return { concepts, total };
  }, {
    maxRetries,
    baseDelayMs: 2000, // Start with 2s delay for server overload
    maxDelayMs: 30000,
    context: 'ECL expansion'
  });
}

/**
 * Expands a full ECL query, paging through ValueSet/$expand results.
 * Previously a single un-paged call — large expansions could be silently
 * truncated at the server's page-size cap.
 */
export async function expandEclQuery(
  eclExpression: string
): Promise<SnomedConcept[]> {
  const PAGE_SIZE = 10000;
  const MAX_PAGES = 50; // Safety cap (500k concepts) against servers that ignore offset

  const all: SnomedConcept[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { concepts, total } = await expandEclPage(eclExpression, offset, PAGE_SIZE);
    all.push(...concepts);
    offset += concepts.length;

    if (new Set(all.map(c => c.code)).size !== all.length) throw new Error('Incomplete terminology expansion: repeated page');
    if (total >= 0 && all.length >= total) return all;
    if (concepts.length === 0) throw new Error('Incomplete terminology expansion: no further page returned');
  }

  throw new Error('Incomplete terminology expansion: page limit reached');
}
