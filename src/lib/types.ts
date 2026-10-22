// === XML Structure Types ===

export interface EmisXmlDocument {
  namespace: string;
  reports: EmisReport[];
  parsedAt: string;
}

export interface EmisReport {
  id: string; // Deterministic ID generated from report content
  xmlId: string; // Original GUID from XML <id> element
  name: string;
  searchName: string; // Extracted from [search_name] brackets
  description?: string; // Description from XML
  parentType?: 'ACTIVE' | 'ALL' | 'POP' | string; // Parent population type (ACTIVE=registered, ALL=all including deducted/deceased, POP=based on another search)
  parentReportId?: string; // If parentType is POP, the GUID of the parent report (matches xmlId of parent)
  rule: string; // Determined by parent structure in XML
  reportType: 'population' | 'listReport'; // population = search/filter, listReport = dashboard with columns
  valueSets: EmisValueSet[];
  criteriaGroups?: CriteriaGroup[];
  columnGroups?: ColumnGroup[]; // For listReport format — each column group defines a dashboard column
}

export interface EmisValueSet {
  id: string;
  codeSystem?: string; // e.g., "SNOMED_CONCEPT", "EMIS", etc.
  description?: string; // XML description — often a cluster ID like STAT_COD
  values: EmisValue[];
  exceptions: EmisException[];
  /**
   * True when the XML used <allValues>: the filter matches every value
   * EXCEPT those listed in `values` (e.g. episode excluding Review/Ended).
   */
  isAllValuesExcept?: boolean;
  /**
   * True when the set only tests the record a restriction keeps
   * (restriction > testAttribute), e.g. "latest record's code is Moderate or
   * Severe frailty". It does not select records, so it is not a code list for
   * the criterion.
   */
  isRestrictionTest?: boolean;
}

export interface EmisValue {
  code: string; // EMIS or SNOMED code (codeSystem determines if translation needed)
  displayName: string;
  includeChildren: boolean;
  isRefset?: boolean; // True if this is a refset ID (should use ^ operator in ECL)
}

export interface EmisException {
  code: string;
  displayName?: string;
}

// === Rule Structure Types ===

export type RuleAction = 'SELECT' | 'REJECT' | 'NEXT';
export type MemberOperator = 'AND' | 'OR';

export interface RangeBoundary {
  operator?: string;
  value?: string;
  unit?: string;
  relation?: string;
}

export interface DateRange {
  from?: RangeBoundary;
  to?: RangeBoundary;
}

export interface ColumnFilter {
  id?: string;
  columns: string[];
  displayName?: string;
  inNotIn?: string;
  range?: DateRange;
  singleValue?: string;
  valueSets?: EmisValueSet[];
  /** Runtime parameter prompted when the search runs (e.g. MONTH_OF_BIRTH) */
  parameter?: { name: string; allowGlobal: boolean };
}

export interface RestrictionCondition {
  column: string;
  operator: string;
  valueSets?: string[];
  rangeValues?: string[];
}

export interface SearchRestriction {
  type: string;
  description: string;
  recordCount?: number;
  direction?: string;
  conditions?: RestrictionCondition[];
}

export interface LinkedRelationship {
  parentColumn?: string;
  childColumn?: string;
  rangeValue?: DateRange;
}

export interface SearchCriterion {
  id: string;
  table: string;
  displayName: string;
  description?: string;
  negation: boolean;
  valueSets: EmisValueSet[];
  columnFilters: ColumnFilter[];
  restrictions: SearchRestriction[];
  exceptionCode?: string;
  linkedCriteria: SearchCriterion[];
  relationship?: LinkedRelationship;
  /**
   * Nested criterion groups (<baseCriteriaGroup>): wrapper criteria whose
   * clinical logic lives in nested criteria with their own operators,
   * negation, filters, restrictions, and linked criteria.
   */
  baseCriteriaGroups?: Array<{ memberOperator: MemberOperator; criteria: SearchCriterion[] }>;
}

export interface PopulationCriterionRef {
  id: string;
  reportGuid: string;
}

export interface CriteriaGroup {
  id: string;
  memberOperator: MemberOperator;
  criteria: SearchCriterion[];
  populationCriteria: PopulationCriterionRef[];
  libraryItemRefs?: string[]; // UUIDs referencing external EMIS library definitions
  actionIfTrue: RuleAction;
  actionIfFalse: RuleAction;
}

// === List Report (Dashboard) Types ===

export interface ListColumn {
  id: string;
  columns: string[]; // e.g. ["DATE"] or ["USUAL_GP", "ORGANISATION_TERM"]
  displayName: string;
}

export interface ColumnGroup {
  id: string;
  logicalTableName: string; // "PATIENTS" or "EVENTS"
  displayName: string; // column header e.g. "Moderate Frailty"
  listColumns: ListColumn[];
  criteria: SearchCriterion[];
}

// === Hierarchical Display Types ===

export interface RuleGroup {
  ruleName: string;
  features: Feature[];
}

export interface Feature {
  id: string;
  name: string;
  displayName: string;
  rule: string;
  valueSets: EmisValueSet[];
  isSelected: boolean;
  isExpanding: boolean;
  expandedCodes?: ExpandedCodeSet;
  error?: string;
}

// === API Response Types ===

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

export interface FhirValueSetExpansion {
  resourceType: 'ValueSet';
  expansion: {
    identifier: string;
    timestamp: string;
    total: number;
    contains: FhirConcept[];
  };
}

export interface FhirConcept {
  inactive?: boolean;
  system: string;
  code: string;
  display: string;
}

export interface ConceptMapTranslateResponse {
  resourceType: 'Parameters';
  parameter?: Array<{
    name: string;
    valueBoolean?: boolean;
    valueString?: string;
    part?: Array<{
      name: string;
      valueCode?: string;
      valueString?: string;
      valueCoding?: {
        system: string;
        code: string;
        display?: string;
      };
    }>;
  }>;
}

export interface TranslatedCode {
  code: string;
  display?: string;
  equivalence?: string;
}

export interface ExpandedCodeSet {
  featureId: string;
  featureName: string;
  concepts: SnomedConcept[];
  totalCount: number;
  sqlFormattedCodes: string; // Single-quoted, comma-separated
  expandedAt: string;
  equivalenceFilterSetting: EquivalenceFilter; // ConceptMap equivalence filter setting used during expansion
  valueSetGroups?: ValueSetGroup[]; // Codes grouped by ValueSet
  error?: string; // Error message if expansion failed
}

export interface ValueSetGroup {
  valueSetId: string; // UUID - unique identifier for the valueset
  valueSetIndex: number;
  valueSetHash: string; // Hash of all codes for duplicate detection
  valueSetFriendlyName: string; // Machine/human readable name (e.g., "diabetes_register_vs1")
  valueSetUniqueName: string; // Same as valueSetId (UUID)
  concepts: SnomedConcept[];
  sqlFormattedCodes: string;
  parentCodes: string[];
  eclExpression?: string; // Formatted ECL expression representing the entire valueset (no URL encoding, no descriptions)
  expansionError?: string; // Error message if expansion failed (e.g., refsets not available)
  failedCodes?: Array<{
    originalCode: string;
    displayName: string;
    codeSystem: string;
    reason: string; // Why it failed (e.g., "No translation found", "Not in terminology server")
  }>;
  // dm+d codes - valid SNOMED codes that can't be expanded (UK Drug Extension not on server)
  dmdCodes?: Array<{
    originalCode: string;
    displayName: string;
    codeSystem: string;
    isDmd: boolean;
    note: string; // Explanation of why it wasn't expanded
  }>;
  // Refset metadata (if this ValueSet contains refsets)
  refsets?: Array<{
    refsetId: string;
    refsetName: string;
  }>;
  // Original XML metadata for debugging
  originalCodes?: Array<{
    originalCode: string;
    displayName: string;
    codeSystem: string;
    includeChildren: boolean;
    isRefset: boolean;
    translatedTo?: string; // SNOMED code after ConceptMap translation
    translatedToDisplay?: string; // Display name of translated SNOMED code
    translationEquivalence?: string;
  }>;
  // Exception (excluded codes) metadata with translation tracking
  exceptions?: Array<{
    originalExcludedCode: string;
    originalExcludedDisplay: string;
    translatedToSnomedCode: string | null;
    includedInEcl: boolean;
    translationError: string | null;
    resolutionStatus?: import('./exception-resolver').ExceptionResolution['status'];
    includeDescendants?: boolean;
    resolutionReason?: string;
  }>;
}

export interface SnomedConcept {
  code: string;
  display: string;
  system: string;
  source: 'parent' | 'child' | 'rf2_file' | 'terminology_server'; // Track source: original code, expanded child, RF2 file, or terminology server
  excludeChildren?: boolean; // True if includeChildren was false for the parent code
  isRefset?: boolean; // True if this code is a refset ID
}

// === ECL Query Types ===

export interface EclQuery {
  expression: string;
  parentCodes: string[];
  excludedCodes: string[];
}

// === Application State Types ===

export interface AppState {
  xmlFile: File | null;
  parsedData: EmisXmlDocument | null;
  ruleGroups: RuleGroup[];
  selectedFeatures: Set<string>;
  expandedFeatures: Map<string, ExpandedCodeSet>;
  isProcessing: boolean;
  error: string | null;
}

// === API Request/Response Types ===

export interface ParseXmlRequest {
  xmlContent: string;
}

export interface ParseXmlResponse {
  success: boolean;
  data?: EmisXmlDocument;
  error?: string;
}

export type EquivalenceFilter = 'strict' | 'with-broader' | 'with-related' | 'all';

export interface ExpandCodesRequest {
  featureId: string;
  featureName: string;
  parentCodes: string[];
  displayNames?: string[];
  excludedCodes: string[];
  excludedDisplayNames?: string[];
  includeChildren: boolean[];
  isRefset?: boolean[];
  codeSystems?: string[];
  valueSetMapping?: ValueSetMapping[];
  equivalenceFilter?: EquivalenceFilter;
}

// === Batch Translation/Resolution API Types ===

export interface TranslateCodesRequest {
  codes: string[];
  equivalenceFilter: EquivalenceFilter;
}

export interface TranslateCodesResponse {
  success: boolean;
  translations?: Record<string, TranslatedCode | null>;
  equivalences?: Record<string, string>;
  error?: string;
}

export interface ResolveHistoricalRequest {
  conceptIds: string[];
}

export interface ResolveHistoricalResponse {
  success: boolean;
  resolutions?: Record<string, { currentConceptId: string; isHistorical: boolean; display?: string }>;
  error?: string;
}

export interface EclExpandRequest {
  ecl: string;
  offset?: number;
  count?: number;
}

export interface EclExpandResponse {
  success: boolean;
  concepts?: SnomedConcept[];
  total?: number;
  offset?: number;
  error?: string;
}

export interface Rf2RefsetRequest {
  refsetIds: string[];
}

export interface Rf2RefsetResponse {
  success: boolean;
  /** Only refsets found in RF2 are present */
  refsets?: Record<string, { members: { code: string; display: string }[]; displayName: string }>;
  error?: string;
}

export interface RawValueSetExpansion {
  exceptionResolutions?: import('./exception-resolver').ExceptionResolution[];
  expansionError?: string;
  concepts: SnomedConcept[];
  parentCodes: string[];
  eclExpression?: string;
  rf2RefsetIds: string[];
  successfulSctConstCodes: string[];
  sctConstNoProducts: Record<string, { substanceCode: string; displayName: string }>;
}

export interface ValueSetMapping {
  valueSetId: string;
  valueSetIndex: number;
  codeIndices: number[]; // Indices in parentCodes array that belong to this ValueSet
  excludedCodes: string[];
  excludedDisplayNames?: string[];
}

export interface ExpandCodesResponse {
  success: boolean;
  data?: ExpandedCodeSet;
  error?: string;
}

export interface BatchExpandRequest {
  features: Array<{
    featureId: string;
    featureName: string;
    parentCodes: string[];
    excludedCodes: string[];
    includeChildren: boolean[];
  }>;
}

export interface BatchExpandResponse {
  success: boolean;
  results: Array<{
    featureId: string;
    data?: ExpandedCodeSet;
    error?: string;
  }>;
}
