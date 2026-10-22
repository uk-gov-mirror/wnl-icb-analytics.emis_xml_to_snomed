import { resolveExceptions, exceptionError, exceptionExclusions } from '@/lib/exception-resolver';
import { buildExceptionsMetadata } from '@/lib/batch-assembly';
import { expandSctConstProducts } from '@/lib/sct-const-expander';
import { NextRequest, NextResponse } from 'next/server';
import {
  ExpandCodesRequest,
  ExpandCodesResponse,
  ExpandedCodeSet,
  ValueSetGroup,
  EmisValue,
} from '@/lib/types';
import { buildBatchedEclQuery, buildBatchedEclQueryWithoutRefsets, separateRefsets, buildFormattedEclExpression } from '@/lib/ecl-builder';
import {
  expandEclQuery,
  findPreparationCandidates,
  findInactivePreparationCandidates,
  classifyExceptionTarget,
  translateEmisCodesToSnomed,
  resolveHistoricalConcepts
} from '@/lib/terminology-client';
import { formatForSql } from '@/lib/sql-formatter';
import { generateValueSetHash, generateValueSetFriendlyName, generateValueSetId } from '@/lib/valueset-utils';
import { expandRefsetsFromRf2, refsetExistsInRf2, getRefsetDisplayName } from '@/lib/rf2-refset-parser';
import { FhirApiError, isFhirApiError } from '@/lib/fhir-error-handler';
import { isDmdCode } from '@/lib/code-system-utils';

// Internal type for values with additional metadata during expansion
interface ValueWithMetadata extends EmisValue {
  originalCode: string;
  translatedSnomedCode?: string;
  codeSystem: string;
}

/**
 * Expands a single ValueSet by processing its codes through translation,
 * historical resolution, and expansion via RF2/terminology server.
 *
 * This handles the complex multi-step process:
 * 1. Build values array with translated/resolved codes
 * 2. Handle SCT_CONST (UK Product expansion)
 * 3. Separate and expand refsets from RF2 files
 * 4. Expand remaining codes via ECL queries
 * 5. Track failed codes and generate metadata
 */
async function expandSingleValueSet(
  mapping: any,
  parentCodes: string[],
  displayNames: string[] | undefined,
  includeChildren: boolean[],
  isRefset: boolean[] | undefined,
  codeSystems: string[] | undefined,
  codeToSnomedMap: Map<string, any>,
  historicalMap: Map<string, string>,
  featureId: string,
  featureName: string,
  allConceptsMap: Map<string, any>,
  equivalences: Record<string, string>
): Promise<ValueSetGroup> {
  const vsOriginalParentCodes = mapping.codeIndices.map((idx: number) => parentCodes[idx]);
  const vsOriginalExcludedCodes = mapping.excludedCodes || [];
  const vsOriginalExcludedDisplayNames: string[] = mapping.excludedDisplayNames || [];
  
  // Debug: log excluded codes
  if (vsOriginalExcludedCodes.length > 0) {
    console.log(`[expandSingleValueSet] ValueSet ${mapping.valueSetIndex + 1} has ${vsOriginalExcludedCodes.length} excluded codes:`, vsOriginalExcludedCodes.slice(0, 5));
  }
  
  const resolutions = await resolveExceptions(
    vsOriginalExcludedCodes.map((code: string, idx: number) => ({ code, displayName: vsOriginalExcludedDisplayNames[idx] })),
    Object.fromEntries(codeToSnomedMap), Object.fromEntries(historicalMap), findPreparationCandidates, findInactivePreparationCandidates, undefined, {
      codeSystem: codeSystems?.[mapping.codeIndices[0]], classifyTarget: classifyExceptionTarget, findExactTarget: expandEclQuery,
    },
  );
  const resolutionError = exceptionError(resolutions);
  if (resolutionError) throw new Error(resolutionError);
  const { descendantCodes: vsExcludedCodes, exactCodes } = exceptionExclusions(resolutions);
  const vsExcludedSet = new Set([...vsExcludedCodes, ...exactCodes]);

  // Build values array for this specific ValueSet
  const vsValues: ValueWithMetadata[] = mapping.codeIndices.map((idx: number) => {
    const originalCode = parentCodes[idx];
    const translatedCode = codeToSnomedMap.get(originalCode);
    const snomedCode = translatedCode?.code || originalCode;
    const currentCode = historicalMap.get(snomedCode) || snomedCode;

    return {
      code: currentCode,
      originalCode,
      translatedSnomedCode: translatedCode?.code, // Store the ConceptMap translated code for SCT_CONST
      displayName: displayNames?.[idx] || '',
      includeChildren: includeChildren[idx] || false,
      isRefset: isRefset?.[idx] || false,
      codeSystem: codeSystems?.[idx] || 'EMISINTERNAL',
    };
  });

  // Handle SCT_CONST codes - expand UK Products for substance codes
  const sctConstCodes = vsValues.filter((v: ValueWithMetadata) => v.codeSystem === 'SCT_CONST');
  let ukProductConcepts: any[] = [];
  // Track which SCT_CONST codes successfully expanded to products (to exclude from failed codes)
  const successfullyExpandedSctConstCodes = new Set<string>();
  // Track SCT_CONST codes that returned 0 products (for better error messages)
  const sctConstCodesWithNoProducts = new Map<string, { substanceCode: string; displayName: string }>();
  // Track UK Product ECL expressions for display purposes
  const ukProductEclExpressions: string[] = [];
  // Track modification ECL expressions to show the full two-step process
  const modificationEclExpressions: string[] = [];

  if (sctConstCodes.length > 0) {
    console.log(`Found ${sctConstCodes.length} SCT_CONST codes, expanding UK Products...`);

    for (const sctConstValue of sctConstCodes) {
      // Skip SCT_CONST codes that have no translation - cannot expand UK Products
      if (!sctConstValue.translatedSnomedCode) {
        console.warn(`  ⚠️  SCT_CONST code ${sctConstValue.originalCode} (${sctConstValue.displayName}) has no ConceptMap translation, skipping UK Product expansion`);
        sctConstCodesWithNoProducts.set(sctConstValue.originalCode, {
          substanceCode: sctConstValue.originalCode,
          displayName: sctConstValue.displayName || sctConstValue.originalCode,
        });
        continue; // Skip to next code
      }

      // Use the translated SNOMED code from ConceptMap
      const substanceCode = sctConstValue.translatedSnomedCode;

      try {
        const { products, productEcl, modificationEcls } = await expandSctConstProducts(
          substanceCode, vsExcludedCodes, expandEclQuery, exactCodes,
        );
        modificationEclExpressions.push(...modificationEcls);
        ukProductEclExpressions.push(productEcl);

        // If we got products, mark this SCT_CONST code as successfully expanded
        if (products.length > 0) {
          successfullyExpandedSctConstCodes.add(sctConstValue.originalCode);
        } else {
          // Track codes that returned 0 products for better error reporting
          sctConstCodesWithNoProducts.set(sctConstValue.originalCode, {
            substanceCode,
            displayName: sctConstValue.displayName || substanceCode,
          });
          console.warn(`  ⚠️  No UK Products found for substance ${substanceCode} (${sctConstValue.displayName || sctConstValue.originalCode}) or its modifications. This may indicate: the substance is not available as a UK Product, the code is historical/inactive, or there's a data issue in the terminology server.`);
        }

        // Mark all products as from terminology server
        products.forEach((product: any) => {
          product.source = 'terminology_server';
          product.excludeChildren = !sctConstValue.includeChildren;
        });

        ukProductConcepts.push(...products);
      } catch (error) {
        // 404 errors are handled by handleFhirResponse and return empty array, so they shouldn't reach here
        // But if they do, allow them (code not found is acceptable)
        if (isFhirApiError(error) && error.status === 404) {
          console.warn(`  UK Products for substance ${substanceCode} returned 404 (not found), continuing...`);
          // Track 404 errors for better error reporting
          sctConstCodesWithNoProducts.set(sctConstValue.originalCode, {
            substanceCode,
            displayName: sctConstValue.displayName || substanceCode,
          });
          // Continue with other substances - 404 means code not found, which is acceptable
          continue;
        }

        // All other errors (network errors, 401, 403, 5xx, etc.) should throw
        // This prevents silently marking codes as failed when there's a real error
        throw error;
      }
    }
  }

  // Filter out SCT_CONST codes from normal expansion (they're handled separately)
  const nonSctConstValues = vsValues.filter((v: ValueWithMetadata) => v.codeSystem !== 'SCT_CONST');

  // Separate refsets from non-refsets
  const { refsets: refsetValues, nonRefsets: nonRefsetValues } = separateRefsets(nonSctConstValues);

  // Also check codes that failed ConceptMap translation - they might be refsets in RF2
  // Check both the original code and the resolved code (after historical resolution)
  const codesThatFailedConceptMap = nonSctConstValues.filter((v: ValueWithMetadata) => {
    const translatedCode = codeToSnomedMap.get(v.originalCode);
    return !translatedCode && !v.isRefset; // Failed translation and not already marked as refset
  });

  // Check if any of these failed codes (or their resolved codes) are refsets in RF2
  const potentialRefsetsFromRf2: ValueWithMetadata[] = [];
  for (const value of codesThatFailedConceptMap) {
    // Check both the original code and the resolved code
    const codesToCheck = [value.code, value.originalCode].filter(Boolean);
    for (const codeToCheck of codesToCheck) {
      if (refsetExistsInRf2(codeToCheck)) {
        console.log(`  Code ${value.originalCode} (resolved: ${value.code}) not translated by ConceptMap but found as refset ${codeToCheck} in RF2`);
        potentialRefsetsFromRf2.push({ ...value, code: codeToCheck, isRefset: true });
        break; // Found it, no need to check other codes
      }
    }
  }

  // Combine detected refsets with potential refsets from RF2
  const allRefsetValues = [...refsetValues, ...potentialRefsetsFromRf2];
  // Filter out potential refsets from non-refsets by comparing codes (since nonRefsetValues are EmisValue type)
  const allNonRefsetValues = nonRefsetValues.filter((v: EmisValue) =>
    !potentialRefsetsFromRf2.some((pr: ValueWithMetadata) => pr.code === v.code || pr.originalCode === v.code)
  );

  console.log(`Expanding ValueSet ${mapping.valueSetIndex + 1} with ${nonSctConstValues.length} codes (${allRefsetValues.length} refsets including ${potentialRefsetsFromRf2.length} found in RF2, ${allNonRefsetValues.length} non-refsets, ${sctConstCodes.length} SCT_CONST handled separately)...`);

  let vsConcepts: any[] = [];

  // First, try expanding refsets from RF2 files
  const refsetIds = allRefsetValues.map(v => v.code);
  const rf2RefsetResults = await expandRefsetsFromRf2(refsetIds);
  const rf2RefsetIds = Array.from(rf2RefsetResults.keys());
  const refsetsNotFoundInRf2 = refsetIds.filter(id => !rf2RefsetIds.includes(id));

  // Add RF2 refset results
  for (const [refsetId, concepts] of rf2RefsetResults) {
    vsConcepts.push(...concepts);
    console.log(`  -> Expanded refset ${refsetId} from RF2: ${concepts.length} members`);
  }

  // For refsets not found in RF2, fall back to ECL queries
  const refsetsToQueryViaEcl = allRefsetValues.filter(v => refsetsNotFoundInRf2.includes(v.code));

  // CRITICAL: Filter to only include codes that have been successfully translated/resolved
  // This prevents sending EMISINTERNAL codes (like "A", "M", "F") or untranslated codes to the terminology server
  // Only include codes that:
  // 1. Have a ConceptMap translation (successfully mapped from EMIS to SNOMED), OR
  // 2. Are refsets (found in RF2 or marked as refsets), OR
  // 3. Are already SNOMED codes (codeSystem === 'SNOMED_CONCEPT')
  const filterToSuccessfullyMappedCodes = (values: EmisValue[]): EmisValue[] => {
    return values.filter((v) => {
      // Check if this is a ValueWithMetadata (has originalCode property)
      const vWithMeta = v as ValueWithMetadata;
      const originalCode = vWithMeta.originalCode || v.code;

      // Check if code has a ConceptMap translation
      const hasTranslation = codeToSnomedMap.has(originalCode);

      // Check if code is a refset (either marked as refset or found in RF2)
      const isRefsetCode = v.isRefset || rf2RefsetIds.includes(v.code);

      // Check if code is already SNOMED (doesn't need translation)
      const isAlreadySnomed = vWithMeta.codeSystem === 'SNOMED_CONCEPT';

      // Include if any of the above conditions are true
      const shouldInclude = hasTranslation || isRefsetCode || isAlreadySnomed;

      if (!shouldInclude) {
        console.log(`  Filtering out unmapped code from ECL: ${originalCode} (codeSystem: ${vWithMeta.codeSystem}, code after resolution: ${v.code})`);
      }

      return shouldInclude;
    });
  };

  // Apply filtering to both non-refsets and refsets
  const filteredNonRefsetValues = filterToSuccessfullyMappedCodes(allNonRefsetValues);
  const filteredRefsetsToQuery = filterToSuccessfullyMappedCodes(refsetsToQueryViaEcl);

  // Build ECL query for non-refsets and refsets not found in RF2 (only successfully mapped codes)
  const valuesForEcl = [...filteredNonRefsetValues, ...filteredRefsetsToQuery];

  console.log(`  -> Filtered to ${valuesForEcl.length} successfully mapped codes for ECL query (${allNonRefsetValues.length + refsetsToQueryViaEcl.length - valuesForEcl.length} codes filtered out)`);

  // Expand via terminology server if needed - use batching to avoid 414 Request-URI Too Large errors
  // Each ECL code with << operator adds ~20-30 characters to the URL
  // Most servers limit URLs to ~8KB, so batch at 50 codes to be safe
  const BATCH_SIZE = 50;

  if (valuesForEcl.length > 0) {
    if (valuesForEcl.length > BATCH_SIZE) {
      console.log(`  -> ValueSet has ${valuesForEcl.length} codes, batching into groups of ${BATCH_SIZE} to avoid URL length limits`);

      for (let i = 0; i < valuesForEcl.length; i += BATCH_SIZE) {
        const batch = valuesForEcl.slice(i, i + BATCH_SIZE);
        const batchEclExpression = buildBatchedEclQuery(batch, vsExcludedCodes, undefined, exactCodes);

        try {
          const batchConcepts = await expandEclQuery(batchEclExpression);
          console.log(`  -> Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(valuesForEcl.length / BATCH_SIZE)}: Got ${batchConcepts.length} concepts`);
          vsConcepts.push(...batchConcepts);
          // Note: Rate limiting handled by concurrency limiter in expandEclQuery
        } catch (error) {
          // 404 errors are handled by handleFhirResponse and return empty array, so they shouldn't reach here
          // But if they do, allow them (code not found is acceptable)
          if (isFhirApiError(error) && error.status === 404) {
            console.warn(`  -> Batch ${Math.floor(i / BATCH_SIZE) + 1} returned 404 (code not found), continuing...`);
            // Continue with other batches - 404 means code not found, which is acceptable
            continue;
          }

          // All other errors (network errors, 401, 403, 5xx, etc.) should throw
          // This prevents silently marking codes as failed when there's a real error
          throw error;
        }
      }
    } else {
      const eclExpression = buildBatchedEclQuery(valuesForEcl, vsExcludedCodes, undefined, exactCodes);
      try {
        const eclConcepts = await expandEclQuery(eclExpression);
        console.log(`  -> Got ${eclConcepts.length} concepts from terminology server for ValueSet ${mapping.valueSetIndex + 1}`);
        vsConcepts.push(...eclConcepts);
      } catch (error) {
        // 404 errors are handled by handleFhirResponse and return empty array, so they shouldn't reach here
        // But if they do, allow them (code not found is acceptable)
        if (isFhirApiError(error) && error.status === 404) {
          console.warn(`ValueSet ${mapping.valueSetIndex + 1} returned 404 (code not found), continuing with RF2 concepts...`);
          // Continue with concepts we already have from RF2 - 404 means code not found, which is acceptable
        } else {
          // All other errors (network errors, 401, 403, 5xx, etc.) should throw
          throw error;
        }
      }
    }
  }

  // Combine normal concepts with UK Product concepts
  vsConcepts = [...vsConcepts, ...ukProductConcepts];

  // Mark parent codes in this ValueSet (preserve source from RF2 or terminology server)
  const vsParentConceptIdSet = new Set(vsValues.map((v: ValueWithMetadata) => v.code));
  vsConcepts.forEach((concept) => {
    // Don't overwrite source - RF2 concepts already have 'rf2_file', ECL concepts have 'terminology_server'
    if (vsParentConceptIdSet.has(concept.code)) {
      const valueIndex = vsValues.findIndex((v: ValueWithMetadata) => v.code === concept.code);
      if (valueIndex !== -1) {
        concept.isRefset = vsValues[valueIndex].isRefset;
        concept.excludeChildren = !vsValues[valueIndex].includeChildren;
      }
    }
    // Add to global concepts map
    if (!allConceptsMap.has(concept.code)) {
      allConceptsMap.set(concept.code, { ...concept });
    }
  });

  for (let i = 0; i < vsExcludedCodes.length; i += 50) {
    const excluded = await expandEclQuery(vsExcludedCodes.slice(i, i + 50).map(c => `<< ${c}`).join(' OR '));
    excluded.forEach(c => vsExcludedSet.add(c.code));
  }
  // Filter out excluded codes
  const filteredConcepts = vsConcepts.filter(
    (c) => !vsExcludedSet.has(c.code)
  );

  // Check if expansion failed for refsets
  const vsIsRefsetFlags = mapping.codeIndices.map((idx: number) => isRefset?.[idx] || false);
  const allRefsets = vsIsRefsetFlags.length > 0 && vsIsRefsetFlags.every((flag: boolean) => flag === true);
  // Check if we only got back the original codes (no expansion happened)
  const originalCodeSet = new Set(vsValues.map((v: ValueWithMetadata) => v.code));
  const hasOnlyOriginalCodes = filteredConcepts.length > 0 && filteredConcepts.every((c: any) => originalCodeSet.has(c.code));
  const expansionError = allRefsets && hasOnlyOriginalCodes
    ? 'Reference set not found. This reference set is not available in the terminology server.'
    : undefined;

  const vsSqlFormatted = formatForSql(filteredConcepts.map((c) => c.code));

  // Build original codes metadata and track failed codes
  const originalCodesMetadata = mapping.codeIndices.map((idx: number) => {
    const originalCode = parentCodes[idx];
    const translatedCode = codeToSnomedMap.get(originalCode);
    const snomedCode = translatedCode?.code || originalCode;
    const currentCode = historicalMap.get(snomedCode) || snomedCode;

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

  // Track refsets that were successfully expanded from RF2
  const successfullyExpandedRefsets = new Set(rf2RefsetIds);

  // Get refset metadata (code and name) for successfully expanded refsets
  const refsetsMetadata = rf2RefsetIds.map(refsetId => ({
    refsetId,
    refsetName: getRefsetDisplayName(refsetId) || `Refset ${refsetId}`,
  }));

  // Track NHS dm+d codes - codes with namespace 1000001 (UK Drug Extension)
  // These are already valid SNOMED codes that came from successful ConceptMap translation
  // They may not expand if the terminology server doesn't have UK Drug Extension loaded
  const dmdCodes = originalCodesMetadata
    .filter((oc: any) => {
      // Check if this is a valid NHS dm+d code (namespace 1000001)
      // Note: EMIS codes (namespace 1000033) need ConceptMap translation first
      return isDmdCode(oc.originalCode) || (oc.translatedTo && isDmdCode(oc.translatedTo));
    })
    .map((oc: any) => ({
      originalCode: oc.originalCode,
      displayName: oc.displayName,
      codeSystem: oc.codeSystem,
      isDmd: true,
      note: 'Valid NHS dm+d code (SNOMED namespace 1000001). May not expand if UK Drug Extension not loaded on terminology server.',
    }));

  if (dmdCodes.length > 0) {
    console.log(`  Found ${dmdCodes.length} valid NHS dm+d codes (namespace 1000001) - not flagging as failures`);
  }

  // Track failed codes - codes that don't appear in expanded concepts
  // Exclude SCT_CONST codes that successfully expanded to UK Products
  // Exclude refsets that successfully expanded from RF2 (refset ID itself isn't a concept)
  // Exclude SCT_PREP codes that are valid dm+d codes (they can't be expanded but are valid)
  const expandedCodeSet = new Set(filteredConcepts.map((c: any) => c.code));
  const dmdCodeSet = new Set(dmdCodes.map((d: any) => d.originalCode));
  const failedCodes = originalCodesMetadata
    .filter((oc: any) => {
      // Skip SCT_CONST codes that successfully expanded to UK Products
      // (The substance codes themselves won't appear in expanded concepts, only the products will)
      if (oc.codeSystem === 'SCT_CONST' && successfullyExpandedSctConstCodes.has(oc.originalCode)) {
        return false;
      }

      // Skip refsets that successfully expanded from RF2
      // (The refset ID itself isn't a concept, so it won't appear in expanded concepts)
      if (oc.isRefset && successfullyExpandedRefsets.has(oc.translatedTo || oc.originalCode)) {
        return false;
      }

      // Skip SCT_PREP codes that are valid dm+d codes
      // These are valid SNOMED codes but can't be expanded without UK Drug Extension
      if (dmdCodeSet.has(oc.originalCode)) {
        return false;
      }

      // Code failed if it doesn't appear in expanded concepts
      // Check both the translated code (if available) and the original code
      const translatedCode = oc.translatedTo || oc.originalCode;
      const codeFound = expandedCodeSet.has(translatedCode) || expandedCodeSet.has(oc.originalCode);

      return !codeFound;
    })
    .map((oc: any) => {
      // Provide clearer error messages for SCT_CONST codes that returned 0 products
      if (oc.codeSystem === 'SCT_CONST' && sctConstCodesWithNoProducts.has(oc.originalCode)) {
        const noProductsInfo = sctConstCodesWithNoProducts.get(oc.originalCode)!;
        
        // Check if this failed because there was no translation
        if (noProductsInfo.substanceCode === oc.originalCode) {
          return {
            originalCode: oc.originalCode,
            displayName: oc.displayName,
            codeSystem: oc.codeSystem,
            reason: `No ConceptMap translation available for this code. Cannot expand UK Products without a valid SNOMED CT substance code.`,
          };
        }
        
        // Failed after successful translation (no products found)
        return {
          originalCode: oc.originalCode,
          displayName: oc.displayName,
          codeSystem: oc.codeSystem,
          reason: `No UK Products found for substance ${noProductsInfo.substanceCode} (${noProductsInfo.displayName}) or its modifications. The system used a two-step process: (1) found all modifications using "Is modification of" relationship (738774007), then (2) queried for UK Products containing the base substance or any modifications. This may indicate: the substance is not available as a UK Product in the terminology server, the code is historical/inactive, or there's a data issue.`,
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

  const vsSnomedParentCodes = vsValues.map((v: ValueWithMetadata) => v.code);

  // Generate hash from original XML codes (before translation) for duplicate detection
  const xmlCodes = vsOriginalParentCodes.sort();
  const valueSetHash = generateValueSetHash(xmlCodes);
  const valueSetFriendlyName = generateValueSetFriendlyName(featureName, mapping.valueSetIndex);
  // Generate deterministic ID based on report ID, valueset index, and valueset hash
  const valueSetId = generateValueSetId(featureId, valueSetHash, mapping.valueSetIndex);

  // Build formatted ECL expression for display (only includes successfully mapped codes)
  // Filter to only include codes that:
  // 1. Have a ConceptMap translation, OR
  // 2. Are refsets (found in RF2 or queried via ECL), OR
  // 3. Are already SNOMED codes (codeSystem === 'SNOMED_CONCEPT')
  // 
  // IMPORTANT: Exclude SCT_CONST codes from regular ECL - they're handled separately via UK Product queries
  // The UK Product ECL expressions are added separately below, so SCT_CONST codes shouldn't appear
  // in the regular ECL expression (which uses << CODE syntax)
  // 
  // Exclude codes that don't have translations and aren't refsets/SNOMED
  // (these are unmapped XML codes that shouldn't appear in the ECL)
  const successfullyMappedCodes = vsValues.filter((v: ValueWithMetadata) => {
    // Exclude SCT_CONST codes - they're handled via UK Product queries, not regular ECL
    // The UK Product queries are tracked separately in ukProductEclExpressions
    if (v.codeSystem === 'SCT_CONST') {
      return false;
    }
    
    // Check if code has a translation
    const hasTranslation = !!v.translatedSnomedCode;
    
    // Check if code is a refset (either marked as refset or found in RF2)
    const isRefsetCode = v.isRefset || rf2RefsetIds.includes(v.code);
    
    // Check if code is already SNOMED (doesn't need translation)
    const isAlreadySnomed = v.codeSystem === 'SNOMED_CONCEPT';
    
    // Include if any of the above conditions are true
    // This ensures we only include codes that have been successfully mapped/translated
    return hasTranslation || isRefsetCode || isAlreadySnomed;
  });
  
  // Convert successfully mapped codes to EmisValue format for ECL builder
  const eclValues = successfullyMappedCodes.map((v: ValueWithMetadata) => ({
    code: v.code,
    displayName: v.displayName,
    includeChildren: v.includeChildren,
    isRefset: v.isRefset,
  }));
  
  // Debug: log filtered codes
  const filteredOutCount = vsValues.length - successfullyMappedCodes.length;
  if (filteredOutCount > 0) {
    console.log(`[expandSingleValueSet] Filtered out ${filteredOutCount} unmapped code(s) from ECL expression for ValueSet ${mapping.valueSetIndex + 1} (${successfullyMappedCodes.length} codes included)`);
  }
  
  // Debug: log before building ECL
  if (vsExcludedCodes.length > 0) {
    console.log(`[expandSingleValueSet] Building ECL for ValueSet ${mapping.valueSetIndex + 1} with ${vsExcludedCodes.length} excluded codes:`, vsExcludedCodes.slice(0, 5));
  }
  
  // Build the base ECL expression for regular codes
  let eclExpression = buildFormattedEclExpression(eclValues, vsExcludedCodes, allConceptsMap, exactCodes);

  // Combine with UK Product ECL expressions for SCT_CONST codes
  // The UK Product ECL expressions already include all substances (base + modifications)
  // from the two-step process, so we just show the final expanded product queries
  if (ukProductEclExpressions.length > 0) {
    const ukProductEclPart = ukProductEclExpressions.join(' OR ');
    
    if (eclExpression) {
      // Combine regular ECL with UK Product ECL expressions using OR
      eclExpression = `(${eclExpression}) OR (${ukProductEclPart})`;
    } else {
      // If no regular ECL, just use the UK Product ECL expressions
      eclExpression = ukProductEclPart;
    }
  }

  // Debug: log the generated ECL
  if (vsExcludedCodes.length > 0 || ukProductEclExpressions.length > 0) {
    console.log(`[expandSingleValueSet] Generated ECL expression for ValueSet ${mapping.valueSetIndex + 1}:`, eclExpression.substring(0, 200));
  }

  // Build exceptions metadata with translation information and error tracking.
  // The raw XML code and displayName are always preserved; translationError records
  // the reason translation failed without dropping the original code.
  const exceptionsMetadata = buildExceptionsMetadata(vsOriginalExcludedCodes,
    vsOriginalExcludedDisplayNames, Object.fromEntries(codeToSnomedMap), Object.fromEntries(historicalMap), resolutions);

  return {
    valueSetId,
    valueSetIndex: mapping.valueSetIndex,
    valueSetHash,
    valueSetFriendlyName,
    valueSetUniqueName: valueSetId, // Use UUID as unique name too
    concepts: filteredConcepts,
    sqlFormattedCodes: vsSqlFormatted,
    parentCodes: vsSnomedParentCodes,
    eclExpression: eclExpression || undefined,
    expansionError,
    failedCodes: failedCodes.length > 0 ? failedCodes : undefined,
    dmdCodes: dmdCodes.length > 0 ? dmdCodes : undefined,
    refsets: refsetsMetadata.length > 0 ? refsetsMetadata : undefined,
    originalCodes: originalCodesMetadata,
    exceptions: exceptionsMetadata.length > 0 ? exceptionsMetadata : undefined,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body: ExpandCodesRequest = await request.json();
    const {
      featureId,
      featureName,
      parentCodes,
      displayNames,
      excludedCodes,
      includeChildren,
      isRefset,
      codeSystems,
      valueSetMapping,
      equivalenceFilter = 'strict',
    } = body;

    if (!parentCodes || parentCodes.length === 0) {
      return NextResponse.json<ExpandCodesResponse>(
        { success: false, error: 'No parent codes provided' },
        { status: 400 }
      );
    }

    // Compute translations and historical resolution
    console.log(`Attempting ConceptMap translation for all ${parentCodes.length} codes (equivalence filter: ${equivalenceFilter})...`);
    const equivalences: Record<string, string> = {};
    const translationCodes = [...new Set([...parentCodes, ...(excludedCodes || []),
      ...(valueSetMapping || []).flatMap(m => m.excludedCodes || [])])];
    const codeToSnomedMap: Map<string, any> = await translateEmisCodesToSnomed(translationCodes, equivalenceFilter, equivalences);
    console.log(`ConceptMap results: ${codeToSnomedMap.size} codes translated, ${parentCodes.length - codeToSnomedMap.size} not found in ConceptMap`);

    // Log first few translated mappings
    let loggedMappings = 0;
    codeToSnomedMap.forEach((translatedCode, originalCode) => {
      if (loggedMappings < 5) {
        console.log(`  Translated: ${originalCode} -> ${translatedCode.code} (${translatedCode.display || 'no display'}, equivalence: ${translatedCode.equivalence || 'unknown'})`);
        loggedMappings++;
      }
    });

    // Fallback: Check if codes that failed ConceptMap translation are refsets in RF2
    const codesNotTranslated = parentCodes.filter(code => !codeToSnomedMap.has(code));
    if (codesNotTranslated.length > 0) {
      console.log(`Checking ${codesNotTranslated.length} untranslated codes against RF2 refsets...`);
      for (const code of codesNotTranslated) {
        if (refsetExistsInRf2(code)) {
          console.log(`  Code ${code} found as refset in RF2, will expand from RF2`);
          const codeIndex = parentCodes.indexOf(code);
          if (codeIndex !== -1 && isRefset) {
            isRefset[codeIndex] = true;
          }
        }
      }
    }

    // Collect all SNOMED codes and resolve historical
    const allSnomedCodes: string[] = [];
    parentCodes.forEach((code) => {
      const translatedCode = codeToSnomedMap.get(code);
      allSnomedCodes.push(translatedCode?.code || code);
    });
    const historicalMap: Map<string, string> = await resolveHistoricalConcepts(allSnomedCodes);

    // Build values array for ECL construction
    const values: Array<{
      code: string;
      originalCode: string;
      displayName: string;
      includeChildren: boolean;
      isRefset: boolean;
    }> = [];

    parentCodes.forEach((originalCode, idx) => {
      // Try translated code first, fallback to original
      const translatedCode = codeToSnomedMap.get(originalCode);
      const snomedCode = translatedCode?.code || originalCode;

      // Get current concept (resolving historical if needed)
      const currentCode = historicalMap.get(snomedCode) || snomedCode;

      values.push({
        code: currentCode, // Use current SNOMED concept ID
        originalCode, // Keep original code for reference
        displayName: displayNames?.[idx] || '',
        includeChildren: includeChildren[idx] || false,
        isRefset: isRefset?.[idx] || false,
      });
    });

    console.log(`Total codes for ECL query: ${values.length}`);

    // CRITICAL FIX: Expand each ValueSet separately to track which child concepts belong to which ValueSet
    // This prevents the bug where all child concepts were added to any ValueSet with includeChildren=true

    const valueSetGroups: ValueSetGroup[] = [];
    const allExcludedCodes = excludedCodes || [];

    // Track all unique concepts across all ValueSets for the combined SQL output
    const allConceptsMap = new Map<string, any>();

    if (valueSetMapping && valueSetMapping.length > 0) {
      // OPTIMIZATION: Group ValueSets by hash and expand each unique hash only once
      // Then propagate results to all ValueSets with the same hash
      
      // Step 1: Pre-compute hash for each mapping
      const mappingWithHash = valueSetMapping.map((mapping: any) => {
        const vsOriginalParentCodes = mapping.codeIndices.map((idx: number) => parentCodes[idx]);
        const xmlCodes = [...vsOriginalParentCodes].sort();
        const hash = generateValueSetHash(xmlCodes);
        const expansionKey = JSON.stringify({ codes: mapping.codeIndices.map((idx: number) =>
          [parentCodes[idx], includeChildren[idx], isRefset?.[idx], codeSystems?.[idx]]),
          exceptions: mapping.excludedCodes, displays: mapping.excludedDisplayNames });
        return { mapping, hash, expansionKey, originalCodes: vsOriginalParentCodes };
      });

      // Step 2: Group by hash
      const hashGroups = new Map<string, typeof mappingWithHash>();
      for (const item of mappingWithHash) {
        if (!hashGroups.has(item.expansionKey)) {
          hashGroups.set(item.expansionKey, []);
        }
        hashGroups.get(item.expansionKey)!.push(item);
      }

      console.log(`Optimization: ${valueSetMapping.length} ValueSets grouped into ${hashGroups.size} unique code sets`);

      // Step 3: Expand each unique hash sequentially with 10ms delay to avoid overwhelming server
      const expandedByHash = new Map<string, ValueSetGroup>();
      const hashEntries = Array.from(hashGroups.entries());

      for (let i = 0; i < hashEntries.length; i++) {
        const [hash, items] = hashEntries[i];
        const firstItem = items[0];

        console.log(`Expanding hash ${hash} (${items.length} ValueSet(s) share this code set)...`);

        const valueSetGroup = await expandSingleValueSet(
          firstItem.mapping,
          parentCodes,
          displayNames,
          includeChildren,
          isRefset,
          codeSystems,
          codeToSnomedMap,
          historicalMap,
          featureId,
          featureName,
          allConceptsMap,
          equivalences
        );

        expandedByHash.set(hash, valueSetGroup);

        if (i < hashEntries.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }

      // Step 4: Propagate results to all ValueSets with the same hash
      for (const item of mappingWithHash) {
        const templateGroup = expandedByHash.get(item.expansionKey)!;
        
        if (item === mappingWithHash.find(m => m.expansionKey === item.expansionKey)) {
          // This is the first (already expanded) ValueSet for this hash
          valueSetGroups.push(templateGroup);
        } else {
          // Clone the template with this ValueSet's specific metadata
          const clonedGroup: ValueSetGroup = {
            ...templateGroup,
            valueSetIndex: item.mapping.valueSetIndex,
            valueSetFriendlyName: generateValueSetFriendlyName(featureName, item.mapping.valueSetIndex),
            valueSetId: generateValueSetId(featureId, item.hash, item.mapping.valueSetIndex),
            valueSetUniqueName: generateValueSetId(featureId, item.hash, item.mapping.valueSetIndex),
            // Concepts, sqlFormattedCodes, eclExpression, etc. are shared
          };
          valueSetGroups.push(clonedGroup);
        }
      }

      // Sort by original valueSetIndex to maintain order
      valueSetGroups.sort((a, b) => a.valueSetIndex - b.valueSetIndex);
    } else {
      // No ValueSet mapping - expand all codes together (legacy behavior)
      const BATCH_SIZE = 50;
      const expandedConcepts: any[] = [];

      // Separate refsets from non-refsets
      const { refsets: refsetValues, nonRefsets: nonRefsetValues } = separateRefsets(values);
      
      // Expand refsets from RF2 first
      const refsetIds = refsetValues.map(v => v.code);
      const rf2RefsetResults = await expandRefsetsFromRf2(refsetIds);
      const rf2RefsetIds = Array.from(rf2RefsetResults.keys());
      const refsetsNotFoundInRf2 = refsetIds.filter(id => !rf2RefsetIds.includes(id));
      
      // Add RF2 refset results
      for (const [refsetId, concepts] of rf2RefsetResults) {
        expandedConcepts.push(...concepts);
        console.log(`Expanded refset ${refsetId} from RF2: ${concepts.length} members`);
      }
      
      // For refsets not found in RF2, add them back to values for ECL query
      const refsetsToQueryViaEcl = refsetValues.filter(v => refsetsNotFoundInRf2.includes(v.code));

      // CRITICAL: Filter to only include codes that have been successfully translated/resolved
      // This prevents sending EMISINTERNAL codes or untranslated codes to the terminology server
      const filterLegacyValues = (values: any[]) => {
        return values.filter((v: any) => {
          const originalCode = v.originalCode || v.code;
          const hasTranslation = codeToSnomedMap.has(originalCode);
          const isRefsetCode = v.isRefset || rf2RefsetIds.includes(v.code);
          const shouldInclude = hasTranslation || isRefsetCode;

          if (!shouldInclude) {
            console.log(`  Filtering out unmapped code from ECL (legacy path): ${originalCode} (code after resolution: ${v.code})`);
          }

          return shouldInclude;
        });
      };

      const filteredNonRefsets = filterLegacyValues(nonRefsetValues as any);
      const filteredRefsetsToQuery = filterLegacyValues(refsetsToQueryViaEcl as any);
      const valuesForEcl = [...filteredNonRefsets, ...filteredRefsetsToQuery];

      console.log(`  -> Filtered to ${valuesForEcl.length} successfully mapped codes for ECL query (legacy path)`);

      if (valuesForEcl.length > BATCH_SIZE) {
        for (let i = 0; i < valuesForEcl.length; i += BATCH_SIZE) {
          const batch = valuesForEcl.slice(i, i + BATCH_SIZE);
          const eclExpression = buildBatchedEclQuery(batch, allExcludedCodes);

          try {
            const batchConcepts = await expandEclQuery(eclExpression);
            expandedConcepts.push(...batchConcepts);
            // Note: Rate limiting handled by concurrency limiter in expandEclQuery
          } catch (error) {
            // 404 errors are handled by handleFhirResponse and return empty array, so they shouldn't reach here
            // But if they do, allow them (code not found is acceptable)
            if (isFhirApiError(error) && error.status === 404) {
              console.warn(`Batch ${Math.floor(i / BATCH_SIZE) + 1} returned 404 (code not found), continuing...`);
              // Continue with other batches - 404 means code not found, which is acceptable
              continue;
            }

            // All other errors (network errors, 401, 403, 5xx, etc.) should throw
            throw error;
          }
        }
      } else if (valuesForEcl.length > 0) {
        const eclExpression = buildBatchedEclQuery(valuesForEcl, allExcludedCodes);
        try {
          const concepts = await expandEclQuery(eclExpression);
          expandedConcepts.push(...concepts);
        } catch (error) {
          // 404 errors are handled by handleFhirResponse and return empty array, so they shouldn't reach here
          // But if they do, allow them (code not found is acceptable)
          if (isFhirApiError(error) && error.status === 404) {
            console.warn(`Expansion returned 404 (code not found), continuing...`);
            // Continue - 404 means code not found, which is acceptable
          } else {
            // All other errors (network errors, 401, 403, 5xx, etc.) should throw
            throw error;
          }
        }
      }

      expandedConcepts.forEach((concept) => {
        allConceptsMap.set(concept.code, concept);
      });
    }

    // Get all concepts from the map for combined SQL output
    const concepts = Array.from(allConceptsMap.values());

    const result: ExpandedCodeSet = {
      featureId,
      featureName,
      concepts,
      totalCount: concepts.length,
      sqlFormattedCodes: formatForSql(concepts.map((c) => c.code)),
      expandedAt: new Date().toISOString(),
      equivalenceFilterSetting: equivalenceFilter,
      valueSetGroups: valueSetGroups.length > 0 ? valueSetGroups : undefined,
    };

    return NextResponse.json<ExpandCodesResponse>({
      success: true,
      data: result,
    });
  } catch (error) {
    const errorDetails = {
      errorMessage: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : typeof error,
      errorStack: error instanceof Error ? error.stack : 'No stack trace',
      errorCause: error instanceof Error && (error as any).cause ? {
        message: (error as any).cause?.message,
        name: (error as any).cause?.name
      } : null,
      errorStringified: JSON.stringify(error, Object.getOwnPropertyNames(error || {})).substring(0, 1000)
    };
    
    console.error('Code expansion error - Full details:', errorDetails);
    console.error('Error object:', error);
    
    return NextResponse.json<ExpandCodesResponse>(
      {
        success: false,
        error:
          error instanceof Error ? error.message : 'Failed to expand codes',
      },
      { status: 500 }
    );
  }
}

export const maxDuration = 300;
