import { EmisValue } from './types';

/**
 * Separates values into refsets and non-refsets
 */
export function separateRefsets(values: EmisValue[]): {
  refsets: EmisValue[];
  nonRefsets: EmisValue[];
} {
  const refsets = values.filter((v) => v.isRefset);
  const nonRefsets = values.filter((v) => !v.isRefset);
  return { refsets, nonRefsets };
}

export function buildBatchedEclQuery(
  values: EmisValue[],
  excludedCodes: string[],
  allConceptsMap?: Map<string, any>, // Optional map of all expanded concepts to check for descendants
  exactExcludedCodes: string[] = [],
): string {
  // Filter out invalid codes (non-numeric codes like 'M', 'F', etc.)
  // SNOMED CT codes should be numeric strings, 6-18 digits long
  const isValidSnomedCode = (code: string): boolean => {
    // Check if code is numeric (allows digits only)
    // SNOMED CT Concept IDs are 6-18 digits long
    return /^\d+$/.test(code) && code.length >= 6 && code.length <= 18;
  };

  // Filter and deduplicate values
  const validValues = values.filter((v) => {
    if (!isValidSnomedCode(v.code)) {
      console.warn('Filtering out invalid SNOMED code:', v.code);
      return false;
    }
    return true;
  });

  // Remove duplicates by code
  const uniqueValues = new Map<string, EmisValue>();
  validValues.forEach((v) => {
    if (!uniqueValues.has(v.code)) {
      uniqueValues.set(v.code, v);
    } else {
      console.warn('Removing duplicate code:', v.code);
    }
  });
  let deduplicatedValues = Array.from(uniqueValues.values());

  // Remove redundant descendant codes: if code A has includeChildren=true and code B is a descendant of A,
  // we only need code A in the ECL (since << A already includes B)
  // This optimization reduces ECL expression length
  // Note: This requires checking the SNOMED hierarchy, which is complex.
  // For now, we keep all codes. A future optimization could:
  // 1. Use the terminology server to check if one code is a descendant of another
  // 2. Use RF2 files to check the hierarchy
  // 3. Track which codes were expanded from which parents and remove redundant descendants

  // Group by type: refsets, codes with children, codes without children
  const refsets = deduplicatedValues.filter((v) => v.isRefset);
  const withChildren = deduplicatedValues.filter((v) => !v.isRefset && v.includeChildren);
  const withoutChildren = deduplicatedValues.filter((v) => !v.isRefset && !v.includeChildren);

  console.log(`ECL Builder - Total: ${deduplicatedValues.length}, Refsets: ${refsets.length}, With descendants (<<): ${withChildren.length}, Exact match: ${withoutChildren.length}`);
  if (withChildren.length > 0) {
    console.log(`Codes with descendants (<< operator):`, withChildren.map(v => v.code).slice(0, 10));
  }


  const parts: string[] = [];

  // Add refsets (using ^ operator)
  if (refsets.length > 0) {
    const refsetParts = refsets.map((v) => `^ ${v.code}`);
    parts.push(...refsetParts);
  }

  // Add codes with descendants (using <<)
  if (withChildren.length > 0) {
    const descendantParts = withChildren.map((v) => `<< ${v.code}`);
    parts.push(...descendantParts);
  }

  // Add exact match codes (no operator, but still need OR separators)
  if (withoutChildren.length > 0) {
    const exactParts = withoutChildren.map((v) => v.code);
    parts.push(...exactParts);
  }

  // Combine ALL parts with OR operator (ensuring consistent formatting)
  // Every part should be separated by OR, regardless of operator type
  let eclExpression = parts.join(' OR ');

  // If no parts, return empty string (will be handled by caller)
  if (!eclExpression || eclExpression.trim() === '') {
    // Don't create MINUS-only expressions - you can't exclude from nothing
    if (excludedCodes.length > 0) {
      console.warn('Cannot create ECL expression with only exclusions (no valid codes to exclude from)');
    }
    return '';
  }

  // Add exclusions if present (validate excluded codes first)
  if (excludedCodes.length > 0 || exactExcludedCodes.length > 0) {
    // Filter out invalid excluded codes (same validation as parent codes)
    const validExcludedCodes = excludedCodes.filter((code) => {
      if (!isValidSnomedCode(code)) {
        console.warn('Filtering out invalid excluded SNOMED code:', code);
        return false;
      }
      return true;
    });

    const validExactCodes = exactExcludedCodes.filter(isValidSnomedCode);
    if (validExcludedCodes.length > 0 || validExactCodes.length > 0) {
      const exclusions = [...validExcludedCodes.map((code) => `<< ${code}`), ...validExactCodes].join(' OR ');
      eclExpression = `(${eclExpression}) MINUS (${exclusions})`;
    } else {
      console.log(`All ${excludedCodes.length} excluded codes were invalid and filtered out`);
    }
  }

  return eclExpression;
}

/**
 * Builds an ECL query for non-refset codes only (excludes refsets)
 */
export function buildBatchedEclQueryWithoutRefsets(
  values: EmisValue[],
  excludedCodes: string[]
): string {
  const nonRefsets = values.filter((v) => !v.isRefset);
  return buildBatchedEclQuery(nonRefsets, excludedCodes);
}

export function estimateEclComplexity(eclExpression: string): number {
  // Rough estimate of query complexity for rate limiting
  const orCount = (eclExpression.match(/OR/g) || []).length;
  const descendantCount = (eclExpression.match(/<</g) || []).length;
  return orCount + descendantCount * 2;
}

/**
 * Builds an ECL query to expand UK Products for a given substance code
 * Format: << (< 10363601000001109 : 762949000 = << {substanceCode})
 */
export function buildUkProductEcl(substanceCode: string): string {
  const UK_PRODUCT_CONCEPT = '10363601000001109';
  const HAS_PRECISE_ACTIVE_INGREDIENT = '762949000';
  
  return `<< (< ${UK_PRODUCT_CONCEPT} : ${HAS_PRECISE_ACTIVE_INGREDIENT} = << ${substanceCode})`;
}

/**
 * Builds an ECL query to find all substances that are modifications of a given substance
 * Uses the "Is modification of" relationship (738774007)
 * 
 * Note: ECL syntax for finding concepts with a specific relationship requires a concept to refine.
 * We use the Substance concept (105590001) and refine it by the "Is modification of" relationship.
 * Format: << 105590001 : 738774007 = << {substanceCode}
 * 
 * This returns substances that have the base substance as their "Is modification of" target
 */
export function buildModificationOfEcl(substanceCode: string): string {
  const SUBSTANCE_CONCEPT = '105590001'; // |Substance|
  const IS_MODIFICATION_OF = '738774007';
  
  // Find all substances that are modifications of the base substance
  // Refine the Substance concept by the "Is modification of" relationship
  return `<< ${SUBSTANCE_CONCEPT} : ${IS_MODIFICATION_OF} = << ${substanceCode}`;
}

/**
 * Builds a formatted ECL expression for display purposes
 * This is the same as buildBatchedEclQuery but with a clearer name for display use
 * Returns a properly formatted ECL expression (not URL encoded, no descriptions)
 */
export function buildFormattedEclExpression(
  values: EmisValue[],
  excludedCodes: string[],
  allConceptsMap?: Map<string, any>,
  exactExcludedCodes: string[] = [],
): string {
  return buildBatchedEclQuery(values, excludedCodes, allConceptsMap, exactExcludedCodes);
}
