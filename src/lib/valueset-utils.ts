import crypto from 'crypto';
import { EmisValueSet } from './types';

/** Expansion identity includes flags and exceptions; exported code hashes stay stable. */
export function generateExpansionKey(vs: EmisValueSet): string {
  return JSON.stringify({
    system: vs.codeSystem,
    values: vs.values.map(v => [v.code, !!v.includeChildren, !!v.isRefset]).sort(),
    exceptions: vs.exceptions.map(e => [e.code, e.displayName || '']).sort(),
    allValuesExcept: !!vs.isAllValuesExcept,
    restrictionTest: !!vs.isRestrictionTest,
  });
}

/**
 * Keyword mapping for shortening valueset names
 * Maps common terms to their abbreviations
 */
const KEYWORD_MAP: Record<string, string> = {
  // Long term conditions
  'diabetes': 'dm',
  'hypertension': 'htn',
  'chronic kidney disease': 'ckd',
  'kidney disease': 'ckd',
  'chronic obstructive pulmonary disease': 'copd',
  'obstructive pulmonary disease': 'copd',
  'asthma': 'asthma', // Keep as-is
  'heart failure': 'hf',
  'coronary heart disease': 'chd',
  'heart disease': 'hd',
  'atrial fibrillation': 'af',
  'fibrillation': 'af',
  'stroke': 'stroke', // Keep as-is
  'epilepsy': 'epilepsy', // Keep as-is
  'dementia': 'dementia', // Keep as-is
  'depression': 'depression', // Keep as-is
  'anxiety': 'anxiety', // Keep as-is
  'osteoarthritis': 'oa',
  'rheumatoid arthritis': 'ra',
  'arthritis': 'ra',
  
  // Common terms
  'register': 'reg',
  'long term condition': '',
  'ltc': '',
  'lcs': '',
  'ltc lcs': '',
  'long term': '',
  
  // Other common abbreviations
  'on': 'on', // Keep as-is
  'and': 'and', // Keep as-is
  'the': 'the', // Keep as-is
  'for': 'for', // Keep as-is
  'of': 'of', // Keep as-is
  'in': 'in', // Keep as-is
  'by': 'by', // Keep as-is
  'with': 'with', // Keep as-is
  'using': 'using', // Keep as-is
  'calculation': 'calc',
  'calculated': 'calc',
  'estimated': 'est',
  'measurement': 'meas',
  'test': 'test', // Keep as-is
  'screening': 'screen',
  'monitoring': 'monitor',
  'management': 'mgmt',
  'treatment': 'tx',
  'therapy': 'tx',
};

/**
 * Applies keyword mappings to shorten words in a string
 * Processes phrases first (longer to shorter), then individual words
 */
function applyKeywordMappings(text: string): string {
  let result = text.toLowerCase().trim();
  
  // First, handle phrase replacements (longer phrases first to avoid partial matches)
  const sortedKeys = Object.keys(KEYWORD_MAP).sort((a, b) => b.length - a.length);
  
  for (const key of sortedKeys) {
    const replacement = KEYWORD_MAP[key];
    // Use word boundaries to match whole words/phrases
    const regex = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    
    if (replacement === '') {
      // Remove the phrase entirely
      result = result.replace(regex, ' ').replace(/\s+/g, ' ').trim();
    } else {
      result = result.replace(regex, replacement);
    }
  }
  
  // Handle special case: "priority group 1" -> "pg1", "priority group 2" -> "pg2", etc.
  result = result.replace(/\bpriority\s+group\s+(\d+)\b/gi, 'pg$1');
  result = result.replace(/\bpg\s+(\d+)\b/gi, 'pg$1'); // Handle if "priority" was already replaced
  
  // Clean up multiple spaces
  result = result.replace(/\s+/g, ' ').trim();
  
  return result;
}

/**
 * Generates a deterministic hash from an array of codes
 * Used to identify duplicate ValueSets across different reports
 */
export function generateValueSetHash(codes: string[]): string {
  // Sort codes to ensure consistent hash regardless of order
  const sortedCodes = [...codes].sort();
  const codeString = sortedCodes.join('|');

  // Generate SHA-256 hash and return first 16 characters for brevity
  const hash = crypto.createHash('sha256').update(codeString).digest('hex');
  return hash.substring(0, 16);
}

/** Safe, stable file name from a report search name */
export function slugifyFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80)
    .replace(/-+$/, '');
  return slug || 'report';
}

/**
 * Generates a machine/human friendly name for a ValueSet
 * Extracts meaningful content from report names, including parenthetical identifiers
 * Applies keyword mappings to shorten common terms
 * Format: meaningfulParts_vs{number}
 * Example: "on_dm_reg_pg1_hrc_vs1"
 */
export function generateValueSetFriendlyName(
  reportName: string,
  valueSetIndex: number
): string {
  // 1. Remove square brackets content
  let processedName = reportName.replace(/\[.*?\]/g, '').trim();

  // 2. Replace parentheses with their content (remove brackets, keep content in place)
  // e.g., "On Diabetes Register (HRC)" -> "On Diabetes Register HRC"
  processedName = processedName.replace(/\(([^)]+)\)/g, ' $1 ');

  // 3. Replace hyphens with spaces (treat as word separators)
  processedName = processedName.replace(/-/g, ' ');

  // 4. Apply keyword mappings to shorten the name
  processedName = applyKeywordMappings(processedName);

  // 5. Sanitize: Convert to lowercase, remove special chars, normalize spaces
  let sanitized = processedName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // Remove all special chars
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/_+/g, '_') // Collapse multiple underscores to single
    .replace(/^_|_$/g, '') // Remove leading/trailing underscores
    .substring(0, 60);

  // Append ValueSet number
  return `${sanitized}_vs${valueSetIndex + 1}`;
}

/**
 * Generates a deterministic ID for a valueset
 * This ID is based on the report ID, valueset index, and valueset hash to ensure consistency across runs
 * Format: uuid-like (8-4-4-4-12)
 * Example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 */
export function generateValueSetId(reportId: string, valueSetHash: string, valueSetIndex: number): string {
  // Create deterministic ID from reportId, valueSetIndex, and valueSetHash
  // Include index to ensure uniqueness even if two valueSets have identical codes
  const content = `${reportId}::${valueSetIndex}::${valueSetHash}`;

  // Generate SHA-256 hash
  const hash = crypto.createHash('sha256').update(content).digest('hex');

  // Format as UUID-like string (8-4-4-4-12)
  const id = `${hash.substring(0, 8)}-${hash.substring(8, 12)}-${hash.substring(12, 16)}-${hash.substring(16, 20)}-${hash.substring(20, 32)}`;

  return id;
}

/**
 * Builds a map from original ValueSet array index to a deduplicated index.
 * ValueSets with identical sorted codes share the same dedup index,
 * so only truly unique code lists get different _vs numbers.
 */
export function buildDeduplicatedIndexMap(
  valueSets: Array<{ values: Array<{ code: string }> }>
): Map<number, number> {
  const indexMap = new Map<number, number>();
  const codeHashToIndex = new Map<string, number>();
  let dedupIndex = 0;

  for (let i = 0; i < valueSets.length; i++) {
    const codeKey = valueSets[i].values.map(v => v.code).sort().join(',');
    const existing = codeHashToIndex.get(codeKey);
    if (existing !== undefined) {
      indexMap.set(i, existing);
    } else {
      codeHashToIndex.set(codeKey, dedupIndex);
      indexMap.set(i, dedupIndex);
      dedupIndex++;
    }
  }

  return indexMap;
}

/**
 * Generates a shorter friendly name using acronyms
 * Keeps parenthetical content in its original position
 * Example: "On Diabetes Register- LTC LCS Priority Group 1 (HRC)" -> "odrltclpg1hrc_vs1"
 */
export function generateValueSetShortName(
  reportName: string,
  valueSetIndex: number
): string {
  // 1. Remove square brackets content
  let processedName = reportName.replace(/\[.*?\]/g, '').trim();

  // 2. Replace parentheses with their content (remove brackets, keep content in place)
  processedName = processedName.replace(/\(([^)]+)\)/g, ' $1 ');

  // 3. Replace hyphens with spaces
  processedName = processedName.replace(/-/g, ' ');

  // 4. Apply keyword mappings
  processedName = applyKeywordMappings(processedName);

  // 5. Extract first letter of each word
  const words = processedName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 0);

  const acronym = words
    .map(word => word[0])
    .join('')
    .substring(0, 15);

  return `${acronym}_vs${valueSetIndex + 1}`;
}
