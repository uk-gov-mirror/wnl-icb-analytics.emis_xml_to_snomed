/**
 * Client-side data model assembly for batch extraction.
 * Builds metadata (failed codes, exceptions, original codes) from raw expansion results.
 */

import { TranslatedCode, SnomedConcept, RawValueSetExpansion, EmisReport, EmisValueSet, EquivalenceFilter } from './types';
import { isDmdCode } from './code-system-utils';
import { formatForSql } from './sql-formatter';
import { prepareValueSetForExpansion } from './valueset-expansion';
import { buildFormattedEclExpression } from './ecl-builder';
import { generateValueSetFriendlyName, generateValueSetId } from './valueset-utils';
import { ExceptionResolution, namesPreparation, exceptionExclusions } from './exception-resolver';

export interface OriginalCodeMetadata {
  originalCode: string;
  displayName: string;
  codeSystem: string;
  includeChildren: boolean;
  isRefset: boolean;
  translatedTo?: string;
  translatedToDisplay?: string;
  translationEquivalence?: string;
}

export interface FailedCode {
  originalCode: string;
  displayName: string;
  codeSystem: string;
  reason: string;
}

export interface ExceptionMetadata {
  originalExcludedCode: string;
  originalExcludedDisplay: string;
  translatedToSnomedCode: string | null;
  includedInEcl: boolean;
  translationError: string | null;
  resolutionStatus?: ExceptionResolution['status'];
  includeDescendants?: boolean;
  resolutionReason?: string;
}

/** Build original codes metadata from raw inputs and pre-computed maps */
export function buildOriginalCodesMetadata(
  parentCodes: string[],
  codeIndices: number[],
  displayNames: string[] | undefined,
  codeSystems: string[] | undefined,
  includeChildren: boolean[],
  isRefset: boolean[] | undefined,
  translationMap: Record<string, TranslatedCode | null>,
  historicalMap: Record<string, string>,
  equivalences: Record<string, string> = {},
): OriginalCodeMetadata[] {
  return codeIndices.map((idx: number) => {
    const originalCode = parentCodes[idx];
    const translatedCode = translationMap[originalCode];
    const snomedCode = translatedCode?.code || originalCode;
    const currentCode = historicalMap[snomedCode] || snomedCode;

    return {
      originalCode,
      displayName: displayNames?.[idx] || '',
      codeSystem: codeSystems?.[idx] || 'EMISINTERNAL',
      includeChildren: includeChildren[idx] || false,
      isRefset: isRefset?.[idx] || false,
      translatedTo: translatedCode ? currentCode : undefined,
      translatedToDisplay: translatedCode?.display,
      translationEquivalence: equivalences[originalCode] || translatedCode?.equivalence || 'unmapped',
    };
  });
}

/** Detect failed codes — codes not found in expanded concepts */
export function detectFailedCodes(
  originalCodes: OriginalCodeMetadata[],
  expandedConcepts: SnomedConcept[],
  successfulSctConstCodes: string[],
  rf2RefsetIds: string[],
  sctConstNoProducts: Record<string, { substanceCode: string; displayName: string }>,
): FailedCode[] {
  const expandedCodeSet = new Set(expandedConcepts.map(c => c.code));
  const successfulSctConstSet = new Set(successfulSctConstCodes);
  const rf2RefsetSet = new Set(rf2RefsetIds);
  const dmdCodeSet = new Set(
    originalCodes
      .filter(oc => isDmdCode(oc.originalCode) || (oc.translatedTo && isDmdCode(oc.translatedTo)))
      .map(oc => oc.originalCode)
  );

  return originalCodes
    .filter(oc => {
      if (oc.codeSystem === 'SCT_CONST' && successfulSctConstSet.has(oc.originalCode)) return false;
      if (oc.isRefset && rf2RefsetSet.has(oc.translatedTo || oc.originalCode)) return false;
      if (dmdCodeSet.has(oc.originalCode)) return false;

      const translatedCode = oc.translatedTo || oc.originalCode;
      return !expandedCodeSet.has(translatedCode) && !expandedCodeSet.has(oc.originalCode);
    })
    .map(oc => {
      if (oc.codeSystem === 'SCT_CONST' && sctConstNoProducts[oc.originalCode]) {
        const info = sctConstNoProducts[oc.originalCode];
        if (info.substanceCode === oc.originalCode) {
          return {
            originalCode: oc.originalCode,
            displayName: oc.displayName,
            codeSystem: oc.codeSystem,
            reason: 'No ConceptMap translation available. Cannot expand UK Products without a valid SNOMED CT substance code.',
          };
        }
        return {
          originalCode: oc.originalCode,
          displayName: oc.displayName,
          codeSystem: oc.codeSystem,
          reason: `No UK Products found for substance ${info.substanceCode} (${info.displayName}) or its modifications.`,
        };
      }

      return {
        originalCode: oc.originalCode,
        displayName: oc.displayName,
        codeSystem: oc.codeSystem,
        reason: oc.translatedTo
          ? 'Not found in terminology server expansion'
          : 'No translation found from ConceptMap',
      };
    });
}

/** Build exception metadata for excluded codes.
 *  Always preserves the raw XML code and displayName in the output row,
 *  regardless of whether ConceptMap translation succeeded — translation_error
 *  carries the failure reason separately.
 */
export function buildExceptionsMetadata(
  excludedCodes: string[],
  excludedDisplayNames: string[] | undefined,
  translationMap: Record<string, TranslatedCode | null>,
  historicalMap: Record<string, string>,
  resolutions?: ExceptionResolution[],
): ExceptionMetadata[] {
  return excludedCodes.map((originalCode, idx) => {
    const originalDisplay = excludedDisplayNames?.[idx] || '';
    const translatedCode = translationMap[originalCode];
    const resolution = resolutions?.find(r => r.originalCode === originalCode);
    if (resolution || namesPreparation(originalDisplay)) return {
      originalExcludedCode: originalCode,
      originalExcludedDisplay: originalDisplay,
      translatedToSnomedCode: resolution?.code || null,
      includedInEcl: !!resolution?.code && !resolution.error,
      translationError: resolution ? resolution.error : 'Preparation exception requires reconciliation',
      resolutionStatus: resolution?.status,
      includeDescendants: resolution?.includeDescendants,
      resolutionReason: resolution?.reason,
    };

    if (!translatedCode) {
      return {
        originalExcludedCode: originalCode,
        originalExcludedDisplay: originalDisplay,
        translatedToSnomedCode: null,
        includedInEcl: false,
        translationError: 'No translation found from ConceptMap',
      };
    }

    const snomedCode = translatedCode.code;
    const resolved = historicalMap[snomedCode] || snomedCode;

    return {
      originalExcludedCode: originalCode,
      originalExcludedDisplay: originalDisplay,
      translatedToSnomedCode: resolved,
      includedInEcl: true,
      translationError: null,
    };
  });
}

/** One ValueSet occurrence within a report, keyed by content hash for dedup */
export interface ExtractionInstance {
  report: EmisReport;
  vsIndex: number;
  vs: EmisValueSet;
  hash: string;
  expansionKey?: string;
}

export interface NormalizedTables {
  reports: any[];
  valuesets: any[];
  originalCodes: any[];
  expandedConcepts: any[];
  failedCodes: any[];
  exceptions: any[];
}

/**
 * Builds the normalized output tables from expansion results.
 * Instances whose hash failed get a valuesets row with expansion_error set
 * (plus original codes and exceptions, which don't depend on expansion) —
 * one failure never discards the rest of the extraction.
 */
export function buildNormalizedTables(
  selectedReports: EmisReport[],
  instances: ExtractionInstance[],
  expandedByHash: Map<string, RawValueSetExpansion>,
  failedByHash: Map<string, string>,
  translations: Record<string, TranslatedCode | null>,
  historical: Record<string, string>,
  equivalenceFilter: EquivalenceFilter,
  equivalences: Record<string, string> = {},
): NormalizedTables {
  const tables: NormalizedTables = {
    reports: [],
    valuesets: [],
    originalCodes: [],
    expandedConcepts: [],
    failedCodes: [],
    exceptions: [],
  };
  const expandedAt = new Date().toISOString();

  for (const report of selectedReports) {
    tables.reports.push({
      report_id: report.id,
      report_xml_id: report.xmlId,
      report_name: report.name,
      search_name: report.searchName,
      description: report.description || '',
      parent_type: report.parentType || '',
      parent_report_id: report.parentReportId || '',
      folder_path: report.rule,
      xml_file_name: report.rule.split(' > ')[0] || 'unknown.xml',
      equivalence_filter_setting: equivalenceFilter,
      parsed_at: expandedAt,
    });
  }

  for (const instance of instances) {
    const prepared = prepareValueSetForExpansion(instance.vs, 0);
    const codeIndices = prepared.parentCodes.map((_: string, idx: number) => idx);
    const valueSetId = generateValueSetId(instance.report.id, instance.hash, instance.vsIndex);
    const friendlyName = generateValueSetFriendlyName(instance.report.name, instance.vsIndex);
    const key = instance.expansionKey || instance.hash;
    const failureMessage = failedByHash.get(key);
    const raw = expandedByHash.get(key);

    // ECL from resolved SNOMED codes — computable even when expansion failed
    const eclValues = prepared.parentCodes.map((code: string, idx: number) => {
      const translated = translations[code];
      const snomedCode = translated?.code || code;
      const currentCode = historical[snomedCode] || snomedCode;
      return {
        code: currentCode,
        displayName: prepared.displayNames[idx],
        includeChildren: prepared.includeChildren[idx],
        isRefset: prepared.isRefset[idx],
      };
    });
    const { descendantCodes, exactCodes } = exceptionExclusions(raw?.exceptionResolutions || []);
    const eclExpression = buildFormattedEclExpression(eclValues, descendantCodes, undefined, exactCodes);


    const pushOriginalCodes = (originalCodes: OriginalCodeMetadata[]) => {
      originalCodes.forEach((oc, idx) => {
        tables.originalCodes.push({
          original_code_id: `${valueSetId}-oc${idx}`,
          valueset_id: valueSetId,
          original_code: oc.originalCode,
          display_name: oc.displayName,
          code_system: oc.codeSystem,
          include_children: oc.includeChildren || false,
          is_refset: oc.isRefset || false,
          translated_to_snomed_code: oc.translatedTo || '',
          translated_to_display: oc.translatedToDisplay || '',
          translation_equivalence: oc.translationEquivalence || 'unmapped',
        });
      });
    };

    const pushExceptions = (exceptions: ExceptionMetadata[]) => {
      exceptions.forEach((exception, excIdx) => {
        tables.exceptions.push({
          exception_id: `${valueSetId}-exc${excIdx}`,
          valueset_id: valueSetId,
          original_excluded_code: exception.originalExcludedCode,
          original_excluded_display: exception.originalExcludedDisplay || '',
          translated_to_snomed_code: exception.translatedToSnomedCode || '',
          included_in_ecl: exception.includedInEcl || false,
          translation_error: exception.translationError || '',
        });
      });
    };

    if (!raw) {
      // Expansion failed for this hash — record the error, keep translation-derived rows
      const originalCodes = buildOriginalCodesMetadata(
        prepared.parentCodes, codeIndices, prepared.displayNames, prepared.codeSystems,
        prepared.includeChildren, prepared.isRefset, translations, historical,
        equivalences,
      );
      const exceptions = buildExceptionsMetadata(
        prepared.excludedCodes, prepared.excludedDisplayNames, translations, historical,
      );

      tables.valuesets.push({
        valueset_id: valueSetId,
        report_id: instance.report.id,
        valueset_index: instance.vsIndex,
        valueset_hash: instance.hash,
        valueset_friendly_name: friendlyName,
        code_system: originalCodes[0]?.codeSystem || '',
        ecl_expression: eclExpression || '',
        expansion_error: failureMessage || 'Expansion did not complete',
        expanded_at: expandedAt,
      });
      pushOriginalCodes(originalCodes);
      pushExceptions(exceptions);
      continue;
    }

    const assembled = assembleValueSetData(
      raw,
      prepared.parentCodes,
      codeIndices,
      prepared.excludedCodes,
      prepared.excludedDisplayNames,
      prepared.displayNames,
      prepared.codeSystems,
      prepared.includeChildren,
      prepared.isRefset,
      translations,
      historical,
      equivalences,
    );

    tables.valuesets.push({
      valueset_id: valueSetId,
      report_id: instance.report.id,
      valueset_index: instance.vsIndex,
      valueset_hash: instance.hash,
      valueset_friendly_name: friendlyName,
      code_system: assembled.originalCodes?.[0]?.codeSystem || '',
      ecl_expression: eclExpression || '',
      expansion_error: assembled.expansionError || '',
      expanded_at: expandedAt,
    });

    pushOriginalCodes(assembled.originalCodes || []);

    const parentCodesSet = new Set(assembled.parentCodes || []);
    assembled.concepts?.forEach((concept, idx) => {
      tables.expandedConcepts.push({
        concept_id: `${valueSetId}-c${idx}`,
        valueset_id: valueSetId,
        snomed_code: concept.code,
        display: concept.display,
        source: concept.source || 'terminology_server',
        exclude_children: concept.excludeChildren || false,
        is_descendant: !parentCodesSet.has(concept.code),
      });
    });

    assembled.failedCodes?.forEach((failed, idx) => {
      tables.failedCodes.push({
        failed_code_id: `${valueSetId}-failed${idx}`,
        valueset_id: valueSetId,
        original_code: failed.originalCode,
        display_name: failed.displayName,
        code_system: failed.codeSystem,
        reason: failed.reason,
      });
    });

    pushExceptions(assembled.exceptions || []);
  }

  return tables;
}

/** Assemble a full ValueSetGroup-equivalent from raw expansion + pre-computed maps */
export function assembleValueSetData(
  raw: RawValueSetExpansion,
  parentCodes: string[],
  codeIndices: number[],
  excludedCodes: string[],
  excludedDisplayNames: string[] | undefined,
  displayNames: string[] | undefined,
  codeSystems: string[] | undefined,
  includeChildren: boolean[],
  isRefset: boolean[] | undefined,
  translationMap: Record<string, TranslatedCode | null>,
  historicalMap: Record<string, string>,
  equivalences: Record<string, string> = {},
) {
  const originalCodes = buildOriginalCodesMetadata(
    parentCodes, codeIndices, displayNames, codeSystems,
    includeChildren, isRefset, translationMap, historicalMap,
    equivalences,
  );

  const failedCodes = raw.expansionError ? [] : detectFailedCodes(
    originalCodes, raw.concepts, raw.successfulSctConstCodes,
    raw.rf2RefsetIds, raw.sctConstNoProducts,
  );

  const exceptions = buildExceptionsMetadata(excludedCodes, excludedDisplayNames, translationMap, historicalMap, raw.exceptionResolutions);

  const sqlFormattedCodes = formatForSql(raw.concepts.map(c => c.code));

  // Check if expansion failed for refsets
  const allRefsets = codeIndices.length > 0 &&
    codeIndices.every((idx: number) => isRefset?.[idx] || false);
  const parentCodeSet = new Set(raw.parentCodes);
  const hasOnlyOriginalCodes = raw.concepts.length > 0 &&
    raw.concepts.every(c => parentCodeSet.has(c.code));
  const expansionError = allRefsets && hasOnlyOriginalCodes
    ? 'Reference set not found. This reference set is not available in the terminology server.'
    : undefined;

  return {
    concepts: raw.concepts,
    parentCodes: raw.parentCodes,
    sqlFormattedCodes,
    originalCodes,
    failedCodes: failedCodes.length > 0 ? failedCodes : undefined,
    exceptions: exceptions.length > 0 ? exceptions : undefined,
    expansionError: raw.expansionError || expansionError,
  };
}
