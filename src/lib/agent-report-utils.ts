import type {
  ColumnGroup,
  CriteriaGroup,
  EmisReport,
  EmisValueSet,
  DateRange,
  RangeBoundary,
  SearchCriterion,
  SearchRestriction,
  ColumnFilter,
  RestrictionCondition,
} from '@/lib/types';
import { formatColumnFilterRange, formatOperator, formatRelationship, formatRestriction, formatRangeBoundary, formatValueSetCondition, humanizeRawTemporal } from '@/lib/rule-format-utils';
import { generateValueSetFriendlyName, generateValueSetHash } from '@/lib/valueset-utils';

export interface ValueSetSummary {
  id: string;
  friendlyName: string;
  preview: string;
  codeCount: number;
  codeSystem: string;
  cluster: string | null;
  exceptionCount: number;
  /** Operators of kept-record tests using this set. */
  testOperators?: string[];
  /** True when the filter matches every value EXCEPT the listed ones */
  isAllValuesExcept: boolean;
  codes: Array<{
    code: string;
    displayName: string;
    includeChildren: boolean;
    isRefset: boolean;
  }>;
}

export interface CriterionDisplayData {
  dedupedValueSets: EmisValueSet[];
  extraValueSets: EmisValueSet[];
  /** Sets that only test the record a restriction keeps, not code lists */
  testValueSets: EmisValueSet[];
  filters: { label: string; value: string; valueSets?: EmisValueSet[]; range?: DateRange }[];
  restrictions: { label: string; value: string }[];
}

export interface RangeBoundarySummary {
  operator: string | null;
  operatorSymbol: string | null;
  value: string | null;
  unit: string | null;
  relation: string | null;
  rendered: string;
}

export interface DateRangeSummary {
  from: RangeBoundarySummary | null;
  to: RangeBoundarySummary | null;
  rendered: string;
}

export interface CriterionFilterSummary {
  id: string | null;
  columns: string[];
  displayName: string | null;
  operator: string | null;
  operatorSymbol: string | null;
  singleValue: string | null;
  rendered: string;
  range: DateRangeSummary | null;
  valueSets: ValueSetSummary[];
  /** Runtime parameter prompted when the search runs */
  parameter: { name: string } | null;
}

export interface RestrictionConditionSummary {
  column: string;
  operator: string;
  operatorSymbol: string;
  valueSets: string[];
  rangeValues: string[];
}

export interface CriterionRestrictionSummary {
  type: string;
  description: string;
  recordCount: number | null;
  direction: string | null;
  conditions: RestrictionConditionSummary[];
  rendered: string;
}

export interface SameColumnConjunction {
  criterionId: string;
  column: string;
  filterIds: string[];
  valueSetNames: string[];
}

export const SAME_COLUMN_CONJUNCTION_CAVEAT = "Check that the lists overlap; if they don't, this criterion selects nobody.";

export function formatSameColumnConjunction(warning: SameColumnConjunction): string {
  return `A single record must match every ${columnLabel(warning.column)} filter (code lists: ${warning.valueSetNames.join(', ')}). ${SAME_COLUMN_CONJUNCTION_CAVEAT}`;
}

export interface RelationshipSummary {
  parentColumn: string | null;
  childColumn: string | null;
  rendered: string;
  range: DateRangeSummary | null;
}

export interface CriterionLogicSummary {
  id: string;
  displayName: string;
  table: string;
  /** Author-written description from the XML, when present */
  description: string | null;
  negation: boolean;
  rendered: string;
  relationship: RelationshipSummary | null;
  valueSets: ValueSetSummary[];
  extraValueSets: ValueSetSummary[];
  filters: CriterionFilterSummary[];
  restrictions: CriterionRestrictionSummary[];
  /** Code lists the restriction tests the kept record against */
  restrictionValueSets: ValueSetSummary[];
  sameColumnConjunctions: SameColumnConjunction[];
  linkedCriteria: CriterionLogicSummary[];
  /** Nested criterion groups (<baseCriteriaGroup>) with their own operator */
  nestedGroups: Array<{ operator: string; criteria: CriterionLogicSummary[] }>;
}

export interface ReportCounts {
  criteriaGroups: number;
  columnGroups: number;
  criteria: number;
  linkedCriteria: number;
  valueSets: number;
  uniqueValueSets: number;
}

export interface ReportDependencySummary {
  parentPopulationReport: { xmlId: string; searchName: string } | null;
  populationCriteriaReports: Array<{ xmlId: string; searchName: string }>;
  libraryItemRefs: string[];
  libraryItems: LibraryItemReferenceSummary[];
}

export interface RuleDecisionSummary {
  kind: 'criteria-group' | 'column-group';
  label: string;
  operator: string | null;
  passAction: string;
  failAction: string;
  clauseType: 'must-match' | 'must-not-match' | 'include-if-match' | 'include-if-match-else-next' | 'include-if-not-match' | 'include-if-not-match-else-next' | 'informational';
  clauseText: string;
  /** Clause text without the clause-type prefix */
  clauseTextRaw: string;
  criteria: string[];
  criteriaDetails: CriterionLogicSummary[];
  populationCriteria: Array<{ xmlId: string; searchName: string }>;
  libraryItems: LibraryItemReferenceSummary[];
  /** Column-group output columns (list reports) */
  outputColumns?: string[];
}

export interface ParentChainEntry {
  id: string;
  xmlId: string;
  title: string;
  searchName: string;
  parentPopulation: string;
  plainEnglishSummary: string;
  booleanLogic: string | null;
  /** Other searches this report combines via population criteria */
  referencedSearches: string[];
  unresolvedLibraryItemRefs: string[];
  unresolvedLibraryItems: LibraryItemReferenceSummary[];
  valueSets: Array<{
    friendlyName: string;
    preview: string;
    codeSystem: string;
    cluster: string | null;
    codeCount: number;
    hash: string;
  }>;
}

export interface LibraryItemReferenceSummary {
  ref: string;
  inferredName: string | null;
  wrapperReports: Array<{
    xmlId: string;
    searchName: string;
    title: string;
  }>;
}

function codeSystemLabel(cs?: string): string {
  switch (cs?.toUpperCase()) {
    case 'SNOMED_CONCEPT': return 'SNOMED';
    case 'SCT_CONST': return 'SCT Const';
    case 'SCT_DRGGRP': return 'Drug Group';
    case 'SCT_APPNAME': return 'Brand';
    case 'EMISINTERNAL': return 'Internal';
    case 'EMIS': return 'EMIS';
    case 'LIBRARY_ITEM': return 'Library';
    default: return cs || 'Unknown';
  }
}

function actionLabel(action: string): string {
  switch (action) {
    case 'SELECT': return 'Include';
    case 'REJECT': return 'Exclude';
    case 'NEXT': return 'Next rule';
    default: return action;
  }
}

function toSentenceCase(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isSingleLibraryItemWrapper(report: EmisReport, ref: string): boolean {
  if ((report.criteriaGroups?.length ?? 0) !== 1) return false;
  if ((report.columnGroups?.length ?? 0) > 0) return false;

  const group = report.criteriaGroups?.[0];
  if (!group) return false;

  return (
    group.criteria.length === 0 &&
    group.populationCriteria.length === 0 &&
    (group.libraryItemRefs?.length ?? 0) === 1 &&
    group.libraryItemRefs?.[0] === ref
  );
}

function cleanLibraryWrapperName(name: string): string {
  return name
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/^LTC LCS:\s*/i, '')
    .replace(/\*+$/, '')
    .trim();
}

export function buildLibraryItemReferenceSummary(ref: string, allReports: EmisReport[]): LibraryItemReferenceSummary {
  const wrapperReports = allReports
    .filter((report) => isSingleLibraryItemWrapper(report, ref))
    .map((report) => ({
      xmlId: report.xmlId,
      searchName: report.searchName,
      title: report.name,
    }));

  const inferredName = wrapperReports.length > 0
    ? cleanLibraryWrapperName(wrapperReports[0].title)
    : null;

  return {
    ref,
    inferredName,
    wrapperReports,
  };
}

function formatLibraryItemReference(ref: string, allReports: EmisReport[]): string {
  const summary = buildLibraryItemReferenceSummary(ref, allReports);
  return summary.inferredName
    ? `${summary.inferredName} (library item ${ref})`
    : `library item ${ref}`;
}

export function formatValueSetPreview(vs: EmisValueSet): string {
  const displayNames = [...new Set(
    vs.values
      .map((v) => v.displayName)
      .filter(Boolean)
  )];

  if (displayNames.length > 0) {
    const preview = displayNames.slice(0, 3).join(', ');
    const remainder = displayNames.length > 3 ? ` +${displayNames.length - 3} more` : '';
    return `${preview}${remainder}`;
  }

  const isRefsetOnly = vs.values.length > 0 && vs.values.every((v) => v.isRefset);
  if (isRefsetOnly) {
    return `Refset${vs.values.length > 1 ? 's' : ''}: ${vs.values.map((v) => v.code).join(', ')}`;
  }

  return vs.description || 'No display names';
}

export function getCriterionDisplayData(criterion: SearchCriterion): CriterionDisplayData {
  const seenCodeHashes = new Set<string>();
  const dedupedValueSets: EmisValueSet[] = [];
  for (const filter of criterion.columnFilters) {
    for (const vs of filter.valueSets ?? []) {
      if (vs.codeSystem?.toUpperCase() === 'EMISINTERNAL') continue;
      const codeKey = generateValueSetHash(vs.values.map((value) => value.code));
      if (!seenCodeHashes.has(codeKey)) {
        seenCodeHashes.add(codeKey);
        dedupedValueSets.push(vs);
      }
    }
  }

  const seenTestHashes = new Set<string>();
  const testValueSets = [
    ...criterion.restrictions.flatMap((restriction) =>
      (restriction.testFilters ?? []).flatMap((filter) => filter.valueSets ?? [])),
    ...criterion.valueSets.filter((vs) => vs.isRestrictionTest),
  ].filter((vs) => {
    const hash = generateValueSetHash(vs.values.map((value) => value.code));
    if (seenTestHashes.has(hash)) return false;
    seenTestHashes.add(hash);
    return true;
  });

  const filters: CriterionDisplayData['filters'] = [];
  for (const cf of criterion.columnFilters) {
    const name = toSentenceCase(filterLabel({ columns: cf.columns, displayName: cf.displayName || null }));
    const op = cf.inNotIn?.toUpperCase() || '';
    if (cf.valueSets?.length) {
      const isEnum = cf.valueSets.every((vs) => vs.codeSystem?.toUpperCase() === 'EMISINTERNAL');
      const simpleEnum = isEnum && cf.valueSets.length === 1 && !cf.valueSets[0].isAllValuesExcept;
      filters.push({
        label: simpleEnum ? `${name}${op === 'NOTIN' ? ' not in' : ''}:` : name,
        value: simpleEnum
          ? cf.valueSets.flatMap((vs) => vs.values.map((value) => value.displayName || prettifyEnumValue(value.code))).join(', ')
          : formatValueSetCondition(cf.valueSets, op === 'NOTIN', (vs) => vs.description || formatValueSetPreview(vs)),
        valueSets: isEnum ? undefined : cf.valueSets,
      });
      continue;
    }
    const value = formatColumnFilterRange(cf.range, cf.columns[0]) || humanizeRawTemporal(cf.singleValue || '', cf.columns[0])
      || (cf.parameter ? `matches the runtime parameter ${cf.parameter.name}` : '');
    if (value) filters.push({ label: name, value: `${op === 'NOTIN' ? 'not ' : ''}${value}`, range: cf.range });
  }
  const restrictions = criterion.restrictions.map((restriction) => ({ label: '', value: formatRestriction(restriction) }));
  return { dedupedValueSets, extraValueSets: [], testValueSets, filters, restrictions };
}

export function getSameColumnConjunctions(
  criterion: SearchCriterion,
  friendlyNameMap: Map<string, string>,
): SameColumnConjunction[] {
  const byColumn = new Map<string, ColumnFilter[]>();
  for (const filter of criterion.columnFilters) {
    if (filter.inNotIn?.toUpperCase() !== 'IN' || !filter.valueSets?.length
      || filter.valueSets.some((vs) => vs.isAllValuesExcept)) continue;
    for (const column of filter.columns) {
      const key = column.toUpperCase();
      const filters = byColumn.get(key) ?? [];
      filters.push(filter);
      byColumn.set(key, filters);
    }
  }
  return [...byColumn].filter(([, filters]) => filters.length > 1).map(([column, filters]) => ({
    criterionId: criterion.id,
    column,
    filterIds: filters.map((filter) => filter.id || `${criterion.id}:filter:${criterion.columnFilters.indexOf(filter) + 1}`),
    valueSetNames: filters.flatMap((filter) => (filter.valueSets ?? []).map((vs) =>
      friendlyNameMap.get(vs.id) || vs.description || formatValueSetPreview(vs))),
  }));
}

function collectCriteria(criteria: SearchCriterion[], accumulator: SearchCriterion[]) {
  for (const criterion of criteria) {
    accumulator.push(criterion);
    collectCriteria(criterion.linkedCriteria, accumulator);
  }
}

function collectValueSets(criteria: SearchCriterion[], friendlyNameMap: Map<string, string>, codeHashToName: Map<string, string>, reportName: string, vsIndexRef: { value: number }) {
  for (const criterion of criteria) {
    for (const vs of criterion.valueSets) {
      if (!friendlyNameMap.has(vs.id)) {
        const codeKey = vs.values.map((v) => v.code).sort().join(',');
        const existing = codeHashToName.get(codeKey);
        if (existing) {
          friendlyNameMap.set(vs.id, existing);
        } else {
          const name = generateValueSetFriendlyName(reportName, vsIndexRef.value);
          friendlyNameMap.set(vs.id, name);
          codeHashToName.set(codeKey, name);
          vsIndexRef.value++;
        }
      }
    }
    collectValueSets(criterion.linkedCriteria, friendlyNameMap, codeHashToName, reportName, vsIndexRef);
  }
}

export function buildFriendlyNameMap(report: EmisReport): Map<string, string> {
  const friendlyNameMap = new Map<string, string>();
  const codeHashToName = new Map<string, string>();
  const vsIndexRef = { value: 0 };

  for (const group of report.criteriaGroups ?? []) {
    collectValueSets(group.criteria, friendlyNameMap, codeHashToName, report.name, vsIndexRef);
  }
  for (const group of report.columnGroups ?? []) {
    collectValueSets(group.criteria, friendlyNameMap, codeHashToName, report.name, vsIndexRef);
  }

  for (const vs of report.valueSets) {
    if (!friendlyNameMap.has(vs.id)) {
      const codeKey = vs.values.map((v) => v.code).sort().join(',');
      const existing = codeHashToName.get(codeKey);
      if (existing) {
        friendlyNameMap.set(vs.id, existing);
      } else {
        const name = generateValueSetFriendlyName(report.name, vsIndexRef.value);
        friendlyNameMap.set(vs.id, name);
        codeHashToName.set(codeKey, name);
        vsIndexRef.value++;
      }
    }
  }

  return friendlyNameMap;
}

export function getParentPopulation(report: EmisReport, allReports: EmisReport[]): string {
  if (report.parentType === 'ACTIVE') {
    return 'Currently registered patients';
  }
  if (report.parentType === 'ALL') {
    return 'All patients (including deducted and deceased)';
  }
  if (report.parentType === 'POP') {
    if (!report.parentReportId) return 'Based on another search';
    const parentReport = allReports.find((r) => r.xmlId === report.parentReportId);
    if (parentReport) {
      return `Based on "${parentReport.searchName}" search results`;
    }
    return `Based on another search (${report.parentReportId})`;
  }
  return report.parentType || 'Not specified';
}

/**
 * Sentence-internal version of getParentPopulation: lowercase lead-in,
 * search names preserved verbatim (never lowercased).
 */
function describeStartingPopulation(report: EmisReport, allReports: EmisReport[]): string {
  if (report.parentType === 'ACTIVE') return 'currently registered patients';
  if (report.parentType === 'ALL') return 'all patients (including deducted and deceased)';
  if (report.parentType === 'POP') {
    const parentReport = allReports.find((r) => r.xmlId === report.parentReportId);
    if (parentReport) return `the patients found by "${parentReport.searchName}"`;
    return 'the patients found by another search';
  }
  return (report.parentType || 'an unspecified population').toLowerCase();
}

function buildValueSetSummary(vs: EmisValueSet, friendlyNameMap: Map<string, string>): ValueSetSummary {
  return {
    id: vs.id,
    friendlyName: friendlyNameMap.get(vs.id) || '(not assigned)',
    preview: formatValueSetPreview(vs),
    codeCount: vs.values.length,
    codeSystem: codeSystemLabel(vs.codeSystem),
    cluster: vs.description || null,
    exceptionCount: vs.exceptions.length,
    isAllValuesExcept: Boolean(vs.isAllValuesExcept),
    codes: vs.values.map((value) => ({
      code: value.code,
      displayName: value.displayName,
      includeChildren: value.includeChildren,
      isRefset: Boolean(value.isRefset),
    })),
  };
}

function buildRangeBoundarySummary(boundary: RangeBoundary | undefined, column?: string): RangeBoundarySummary | null {
  if (!boundary) return null;
  const operatorSymbol = boundary.operator ? formatOperator(boundary.operator) : null;
  const rendered = (!boundary.unit && !boundary.relation)
    ? [operatorSymbol, boundary.value].filter(Boolean).join(' ').trim()
    : formatColumnFilterRange({ from: boundary }, column) || formatRangeBoundary(boundary);
  return {
    operator: boundary.operator || null,
    operatorSymbol,
    value: boundary.value || null,
    unit: boundary.unit || null,
    relation: boundary.relation || null,
    rendered,
  };
}

function buildDateRangeSummary(range: DateRange | undefined, column?: string): DateRangeSummary | null {
  if (!range) return null;
  return {
    from: buildRangeBoundarySummary(range.from, column),
    to: buildRangeBoundarySummary(range.to, column),
    rendered: formatColumnFilterRange(range, column),
  };
}

function buildRestrictionConditionSummary(condition: RestrictionCondition): RestrictionConditionSummary {
  return {
    column: condition.column,
    operator: condition.operator,
    operatorSymbol: formatOperator(condition.operator),
    valueSets: condition.valueSets ?? [],
    rangeValues: condition.rangeValues ?? [],
  };
}

function buildRestrictionSummary(restriction: SearchRestriction): CriterionRestrictionSummary {
  return {
    type: restriction.type,
    description: restriction.description,
    recordCount: restriction.recordCount ?? null,
    direction: restriction.direction ?? null,
    conditions: (restriction.conditions ?? []).map(buildRestrictionConditionSummary),
    rendered: formatRestriction(restriction),
  };
}

function buildFilterSummary(
  filter: ColumnFilter,
  friendlyNameMap: Map<string, string>,
): CriterionFilterSummary {
  const primaryColumn = filter.columns[0] || '';
  const displayName = filter.displayName || filter.columns.join(', ') || null;
  const summary: CriterionFilterSummary = {
    id: filter.id || null,
    columns: filter.columns,
    displayName,
    operator: filter.inNotIn || null,
    operatorSymbol: filter.inNotIn ? formatOperator(filter.inNotIn) : null,
    singleValue: filter.singleValue || null,
    rendered: '',
    range: buildDateRangeSummary(filter.range, primaryColumn),
    valueSets: (filter.valueSets ?? []).map((vs) => buildValueSetSummary(vs, friendlyNameMap)),
    parameter: filter.parameter ? { name: filter.parameter.name } : null,
  };
  return { ...summary, rendered: filter.parameter
    ? `${filterLabel(summary)} matches the runtime parameter ${filter.parameter.name}`
    : humanFilter(summary) };
}

function buildRelationshipSummary(criterion: SearchCriterion): RelationshipSummary | null {
  if (!criterion.relationship) return null;
  return {
    parentColumn: criterion.relationship.parentColumn || null,
    childColumn: criterion.relationship.childColumn || null,
    rendered: formatRelationship(criterion.relationship),
    range: buildDateRangeSummary(criterion.relationship.rangeValue, criterion.relationship.childColumn),
  };
}

function buildCriterionLogicSummary(
  criterion: SearchCriterion,
  friendlyNameMap: Map<string, string>,
): CriterionLogicSummary {
  const displayData = getCriterionDisplayData(criterion);

  const nestedGroups = (criterion.baseCriteriaGroups ?? []).map((group) => ({
    operator: group.memberOperator,
    criteria: group.criteria.map((nested) => buildCriterionLogicSummary(nested, friendlyNameMap)),
  }));

  // Hoisted nested-group value sets belong on the nested criteria; keep the
  // wrapper criterion's own sets only
  const nestedVsIds = new Set<string>();
  for (const group of criterion.baseCriteriaGroups ?? []) {
    const collectIds = (criteria: SearchCriterion[]) => {
      for (const nested of criteria) {
        nested.valueSets.forEach((vs) => nestedVsIds.add(vs.id));
        for (const filter of nested.columnFilters) {
          (filter.valueSets ?? []).forEach((vs) => nestedVsIds.add(vs.id));
        }
        collectIds(nested.linkedCriteria);
        for (const sub of nested.baseCriteriaGroups ?? []) collectIds(sub.criteria);
      }
    };
    collectIds(group.criteria);
  }
  const ownValueSets = displayData.dedupedValueSets.filter((vs) => !nestedVsIds.has(vs.id));

  return {
    id: criterion.id,
    displayName: criterion.displayName || 'Unnamed criterion',
    table: criterion.table,
    description: criterion.description || null,
    negation: criterion.negation,
    rendered: buildCriterionPhrase(criterion),
    relationship: buildRelationshipSummary(criterion),
    valueSets: ownValueSets.map((vs) => buildValueSetSummary(vs, friendlyNameMap)),
    extraValueSets: displayData.extraValueSets.map((vs) => buildValueSetSummary(vs, friendlyNameMap)),
    filters: criterion.columnFilters.map((filter) => buildFilterSummary(filter, friendlyNameMap)),
    restrictions: criterion.restrictions.map(buildRestrictionSummary),
    restrictionValueSets: displayData.testValueSets
      .filter((vs) => !nestedVsIds.has(vs.id))
      .map((vs) => ({
        ...buildValueSetSummary(vs, friendlyNameMap),
        testOperators: [...new Set(criterion.restrictions.flatMap((restriction) =>
          (restriction.testFilters ?? []).filter((filter) => filter.valueSets?.some((set) => set.id === vs.id))
            .map((filter) => filter.inNotIn || 'IN')))],
      })),
    sameColumnConjunctions: getSameColumnConjunctions(criterion, friendlyNameMap),
    linkedCriteria: criterion.linkedCriteria.map((linked) => buildCriterionLogicSummary(linked, friendlyNameMap)),
    nestedGroups,
  };
}

export function getReportCounts(report: EmisReport): ReportCounts {
  const criteria: SearchCriterion[] = [];
  for (const group of report.criteriaGroups ?? []) {
    collectCriteria(group.criteria, criteria);
  }
  for (const group of report.columnGroups ?? []) {
    collectCriteria(group.criteria, criteria);
  }

  const linkedCriteria = criteria.filter((criterion) => criterion.linkedCriteria.length > 0)
    .reduce((sum, criterion) => sum + criterion.linkedCriteria.length, 0);
  const uniqueValueSetKeys = new Set(report.valueSets.map((vs) => vs.values.map((value) => value.code).sort().join(',')));

  return {
    criteriaGroups: report.criteriaGroups?.length ?? 0,
    columnGroups: report.columnGroups?.length ?? 0,
    criteria: criteria.length,
    linkedCriteria,
    valueSets: report.valueSets.length,
    uniqueValueSets: uniqueValueSetKeys.size,
  };
}

function getUniqueValueSets(report: EmisReport): EmisValueSet[] {
  const seen = new Set<string>();
  const unique: EmisValueSet[] = [];
  for (const vs of report.valueSets) {
    const key = vs.values.map((value) => value.code).sort().join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(vs);
  }
  return unique;
}

export function buildRulesMarkdown(report: EmisReport, allReports: EmisReport[]): string {
  const groups = report.criteriaGroups ?? [];
  const colGroups = report.columnGroups ?? [];
  const friendlyNameMap = buildFriendlyNameMap(report);
  const lines: string[] = [];

  const resolveReportName = (reportGuid: string): string => {
    const ref = allReports.find((r) => r.xmlId === reportGuid);
    return ref ? ref.searchName : `${reportGuid.slice(0, 8)}...`;
  };

  const addValueSet = (vs: EmisValueSet, indent: string) => {
    const summary = buildValueSetSummary(vs, friendlyNameMap);
    lines.push(`${indent}- ValueSet friendly name: \`${summary.friendlyName}\``);
    lines.push(`${indent}- Preview: ${summary.preview}`);
    lines.push(`${indent}- Code count: ${summary.codeCount}`);
    lines.push(`${indent}- Code system: ${summary.codeSystem}`);
    if (summary.cluster) {
      lines.push(`${indent}- Cluster: ${summary.cluster}`);
    }
    if (summary.exceptionCount > 0) {
      lines.push(`${indent}- Excluded codes: ${summary.exceptionCount}`);
    }
  };

  const addCriterion = (criterion: SearchCriterion, indent: string) => {
    const criterionSummary = buildCriterionLogicSummary(criterion, friendlyNameMap);
    lines.push(`${indent}- ${criterion.displayName || 'Unnamed criterion'} [${criterion.table}]`);
    if (criterion.negation) {
      lines.push(`${indent}  - NOT`);
    }
    if (criterionSummary.relationship) {
      lines.push(`${indent}  - Linked relationship: ${criterionSummary.relationship.rendered}`);
      if (criterionSummary.relationship.range) {
        if (criterionSummary.relationship.range.from) {
          lines.push(`${indent}    - From: ${criterionSummary.relationship.range.from.rendered}`);
        }
        if (criterionSummary.relationship.range.to) {
          lines.push(`${indent}    - To: ${criterionSummary.relationship.range.to.rendered}`);
        }
      }
    }

    const { dedupedValueSets, extraValueSets, filters, restrictions } = getCriterionDisplayData(criterion);

    if (dedupedValueSets.length > 0) {
      lines.push(`${indent}  - ValueSets:`);
      for (const vs of dedupedValueSets) addValueSet(vs, `${indent}    `);
    }
    if (extraValueSets.length > 0) {
      lines.push(`${indent}  - Additional READCODE ValueSets:`);
      for (const vs of extraValueSets) addValueSet(vs, `${indent}    `);
    }
    if (filters.length > 0) {
      const where = filters.map((filter) => (filter.label ? `${filter.label} ${filter.value}` : filter.value)).join(' AND ');
      lines.push(`${indent}  - Where: ${where}`);
      for (const filter of criterionSummary.filters) {
        lines.push(`${indent}    - Filter detail: ${filter.rendered}`);
        if (filter.range?.from) {
          lines.push(`${indent}      - From boundary: ${filter.range.from.rendered}`);
        }
        if (filter.range?.to) {
          lines.push(`${indent}      - To boundary: ${filter.range.to.rendered}`);
        }
        if (filter.valueSets.length > 0) {
          lines.push(`${indent}      - Filter ValueSets: ${filter.valueSets.map((vs) => `\`${vs.friendlyName}\``).join(', ')}`);
        }
      }
    }
    for (const warning of criterionSummary.sameColumnConjunctions) {
      lines.push(`${indent}  - ${formatSameColumnConjunction(warning)}`);
    }
    if (restrictions.length > 0) {
      const then = restrictions.map((restriction) => (restriction.label ? `${restriction.label} ${restriction.value}` : restriction.value)).join(' AND ');
      lines.push(`${indent}  - Then: ${then}`);
      for (const restriction of criterionSummary.restrictions) {
        lines.push(`${indent}    - Restriction detail: ${restriction.description}`);
        if (restriction.recordCount !== null) {
          lines.push(`${indent}      - Record count: ${restriction.recordCount}`);
        }
        if (restriction.direction) {
          lines.push(`${indent}      - Direction: ${restriction.direction}`);
        }
        for (const condition of restriction.conditions) {
          const conditionParts: string[] = [
            `${condition.column} ${condition.operatorSymbol || condition.operator}`,
          ];
          if (condition.valueSets.length > 0) {
            conditionParts.push(condition.valueSets.join(', '));
          }
          if (condition.rangeValues.length > 0) {
            conditionParts.push(condition.rangeValues.join(' and '));
          }
          lines.push(`${indent}      - Condition: ${conditionParts.join(' | ')}`);
        }
      }
      if (criterionSummary.restrictionValueSets.length > 0) {
        lines.push(`${indent}    - Restriction test ValueSets (test the kept record, not code lists):`);
        for (const vs of criterionSummary.restrictionValueSets) {
          lines.push(`${indent}      - \`${vs.friendlyName}\`${testOperatorSuffix(vs)}: ${vs.preview} (${vs.codeCount} code${vs.codeCount === 1 ? '' : 's'})`);
        }
      }
    }
    if (criterion.linkedCriteria.length > 0) {
      lines.push(`${indent}  - Linked criteria:`);
      for (const linked of criterion.linkedCriteria) addCriterion(linked, `${indent}    `);
    }
    for (const group of criterion.baseCriteriaGroups ?? []) {
      lines.push(`${indent}  - Nested group (${group.memberOperator}):`);
      for (const nested of group.criteria) addCriterion(nested, `${indent}    `);
    }
  };

  lines.push(`# ${report.name}`);
  lines.push(`Title: ${report.name}`);
  if (report.searchName !== report.name) lines.push(`Search name: ${report.searchName}`);
  if (report.description) lines.push(`Description: ${report.description}`);
  lines.push(`Parent population: ${getParentPopulation(report, allReports)}`);
  lines.push(`ValueSets: ${report.valueSets.length}`);
  lines.push('');

  if (groups.length > 0) {
    for (let idx = 0; idx < groups.length; idx++) {
      const group = groups[idx];
      let ruleName = `Rule ${idx + 1}`;
      if (groups.length > 1) {
        ruleName += idx === 0 ? ' (Primary)' : ' (Additional)';
      }
      lines.push(`## ${ruleName}`);
      lines.push(`Pass: ${actionLabel(group.actionIfTrue)}`);
      lines.push(`Fail: ${actionLabel(group.actionIfFalse)}`);
      if (group.populationCriteria.length > 0) {
        for (const pc of group.populationCriteria) {
          lines.push(`Patients included in search: ${resolveReportName(pc.reportGuid)}`);
        }
      }
      if (group.criteria.length > 0) {
        lines.push(`Criteria operator: ${group.memberOperator}`);
        for (const criterion of group.criteria) addCriterion(criterion, '');
      } else if (group.libraryItemRefs && group.libraryItemRefs.length > 0) {
        lines.push(`Library item references: ${group.libraryItemRefs.map((ref) => formatLibraryItemReference(ref, allReports)).join(', ')}`);
      } else {
        lines.push('No criteria in this rule.');
      }
      lines.push('');
    }
  }

  if (colGroups.length > 0) {
    lines.push('## Column Groups');
    for (const cg of colGroups) {
      lines.push(`### ${cg.displayName} [${cg.logicalTableName}]`);
      if (cg.listColumns.length > 0) {
        lines.push(`Shows: ${cg.listColumns.map((lc) => lc.displayName).join(', ')}`);
      }
      if (cg.criteria.length > 0) {
        for (const criterion of cg.criteria) addCriterion(criterion, '');
      } else {
        lines.push('No criteria in this column.');
      }
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

function buildCriteriaSearchText(criteria: SearchCriterion[]): string {
  const parts: string[] = [];
  const visit = (criterion: SearchCriterion) => {
    parts.push(criterion.displayName || '');
    parts.push(criterion.table);
    for (const { dedupedValueSets, extraValueSets, testValueSets, filters, restrictions } of [getCriterionDisplayData(criterion)]) {
      for (const vs of [...dedupedValueSets, ...extraValueSets, ...testValueSets]) {
        parts.push(formatValueSetPreview(vs));
        parts.push(vs.description || '');
        parts.push(vs.values.map((value) => value.displayName).join(' '));
        parts.push(vs.values.map((value) => value.code).join(' '));
      }
      for (const filter of filters) parts.push(`${filter.label} ${filter.value}`);
      for (const restriction of restrictions) parts.push(`${restriction.label} ${restriction.value}`);
    }
    for (const linked of criterion.linkedCriteria) visit(linked);
    for (const group of criterion.baseCriteriaGroups ?? []) {
      for (const nested of group.criteria) visit(nested);
    }
  };
  for (const criterion of criteria) visit(criterion);
  return parts.join(' ').toLowerCase();
}

function buildCriterionPhrase(criterion: SearchCriterion): string {
  const parts: string[] = [];
  const { filters, restrictions } = getCriterionDisplayData(criterion);
  const label = criterion.displayName || criterion.table;
  parts.push(label);
  if (criterion.negation) {
    parts.push('NOT');
  }
  if (filters.length > 0) {
    parts.push(`where ${filters.map((filter, index) => {
      const previous = filters[index - 1];
      const repeatRangeLabel = previous?.label === filter.label && previous.range && filter.range;
      return filter.label && !repeatRangeLabel ? `${filter.label} ${filter.value}` : filter.value;
    }).join(' AND ')}`);
  }
  if (restrictions.length > 0) {
    parts.push(`then ${restrictions.map((restriction) => {
      const text = restriction.label ? `${restriction.label} ${restriction.value}` : restriction.value;
      return (text.charAt(0).toLowerCase() + text.slice(1)).replace(', then test', ' and test');
    }).join(' AND ')}`);
  }
  for (const group of criterion.baseCriteriaGroups ?? []) {
    parts.push(`with nested group (${group.criteria.map((nested) => buildCriterionPhrase(nested)).join(` ${group.memberOperator} `)})`);
  }
  return parts.join(' ');
}

function buildGroupClauseText(group: CriteriaGroup, allReports: EmisReport[]): string {
  const criteriaParts = group.criteria.map((criterion) => buildCriterionPhrase(criterion));
  const populationRefs = group.populationCriteria.map((pc) => {
    const report = allReports.find((candidate) => candidate.xmlId === pc.reportGuid);
    return `patients included in search ${report?.searchName || pc.reportGuid}`;
  });
  const libraryRefs = (group.libraryItemRefs ?? []).map((ref) => formatLibraryItemReference(ref, allReports));
  const allParts = [...populationRefs, ...criteriaParts, ...libraryRefs];
  return allParts.join(` ${group.memberOperator} `);
}

function buildColumnGroupClauseText(group: ColumnGroup): string {
  if (group.criteria.length === 0) {
    return `${group.displayName} [${group.logicalTableName}]`;
  }
  return group.criteria.map((criterion) => buildCriterionPhrase(criterion)).join(' AND ');
}

function getClauseType(passAction: string, failAction: string): RuleDecisionSummary['clauseType'] {
  if (passAction === 'Next rule' && failAction === 'Exclude') return 'must-match';
  if (passAction === 'Exclude' && failAction === 'Next rule') return 'must-not-match';
  if (passAction === 'Include' && failAction === 'Exclude') return 'include-if-match';
  // OR-cascade: matching patients are included and stop; others try the next rule
  if (passAction === 'Include' && failAction === 'Next rule') return 'include-if-match-else-next';
  if (passAction === 'Exclude' && failAction === 'Include') return 'include-if-not-match';
  // "If Rule Failed: Include in final result" — failing patients are included
  // and stop; matching patients try the next rule (therapy-gap chains)
  if (passAction === 'Next rule' && failAction === 'Include') return 'include-if-not-match-else-next';
  return 'informational';
}

function clauseTextForType(clauseType: RuleDecisionSummary['clauseType'], clauseText: string): string {
  switch (clauseType) {
    case 'must-match':
      return `Must match: ${clauseText}`;
    case 'must-not-match':
      return `Must not match: ${clauseText}`;
    case 'include-if-match':
      return `Included if matches: ${clauseText}`;
    case 'include-if-match-else-next':
      return `Included if matches (otherwise next rule): ${clauseText}`;
    case 'include-if-not-match':
      return `Included if it does not match: ${clauseText}`;
    case 'include-if-not-match-else-next':
      return `Included if it does not match (otherwise next rule): ${clauseText}`;
    default:
      return clauseText;
  }
}

function buildDecisionFlow(report: EmisReport, allReports: EmisReport[]): RuleDecisionSummary[] {
  const decisions: RuleDecisionSummary[] = [];
  const friendlyNameMap = buildFriendlyNameMap(report);

  for (let idx = 0; idx < (report.criteriaGroups ?? []).length; idx++) {
    const group = report.criteriaGroups![idx];
    let label = `Rule ${idx + 1}`;
    if ((report.criteriaGroups?.length ?? 0) > 1) {
      label += idx === 0 ? ' (Primary)' : ' (Additional)';
    }
    const passAction = actionLabel(group.actionIfTrue);
    const failAction = actionLabel(group.actionIfFalse);
    const clauseType = getClauseType(passAction, failAction);
    const clauseText = buildGroupClauseText(group, allReports);
    decisions.push({
      kind: 'criteria-group',
      label,
      operator: group.memberOperator,
      passAction,
      failAction,
      clauseType,
      clauseText: clauseTextForType(clauseType, clauseText),
      clauseTextRaw: clauseText,
      criteria: group.criteria.map((criterion) => buildCriterionPhrase(criterion)),
      criteriaDetails: group.criteria.map((criterion) => buildCriterionLogicSummary(criterion, friendlyNameMap)),
      populationCriteria: group.populationCriteria.map((pc) => {
        const match = allReports.find((candidate) => candidate.xmlId === pc.reportGuid);
        return {
          xmlId: pc.reportGuid,
          searchName: match?.searchName || pc.reportGuid,
        };
      }),
      libraryItems: (group.libraryItemRefs ?? []).map((ref) => buildLibraryItemReferenceSummary(ref, allReports)),
    });
  }

  for (const group of report.columnGroups ?? []) {
    const clauseText = buildColumnGroupClauseText(group);
    decisions.push({
      kind: 'column-group',
      label: group.displayName,
      operator: 'AND',
      passAction: 'Informational',
      failAction: 'Informational',
      clauseType: 'informational',
      clauseText,
      clauseTextRaw: clauseText,
      criteria: group.criteria.map((criterion) => buildCriterionPhrase(criterion)),
      criteriaDetails: group.criteria.map((criterion) => buildCriterionLogicSummary(criterion, friendlyNameMap)),
      populationCriteria: [],
      libraryItems: [],
      outputColumns: group.listColumns.map((column) => column.displayName).filter(Boolean),
    });
  }

  return decisions;
}

function buildDependencies(report: EmisReport, allReports: EmisReport[]): ReportDependencySummary {
  const populationCriteriaReports: Array<{ xmlId: string; searchName: string }> = [];
  const libraryItemRefs: string[] = [];
  const libraryItems: LibraryItemReferenceSummary[] = [];

  for (const group of report.criteriaGroups ?? []) {
    for (const pc of group.populationCriteria) {
      const match = allReports.find((candidate) => candidate.xmlId === pc.reportGuid);
      populationCriteriaReports.push({
        xmlId: pc.reportGuid,
        searchName: match?.searchName || pc.reportGuid,
      });
    }
    for (const ref of group.libraryItemRefs ?? []) {
      libraryItemRefs.push(ref);
      libraryItems.push(buildLibraryItemReferenceSummary(ref, allReports));
    }
  }

  const parentPopulationReport = report.parentType === 'POP' && report.parentReportId
    ? (() => {
        const match = allReports.find((candidate) => candidate.xmlId === report.parentReportId);
        return {
          xmlId: report.parentReportId,
          searchName: match?.searchName || report.parentReportId,
        };
      })()
    : null;

  return {
    parentPopulationReport,
    populationCriteriaReports,
    libraryItemRefs,
    libraryItems,
  };
}

/**
 * Builds an exact boolean expression for a sequential EMIS rule chain.
 * Each rule routes to Include, Exclude, or the next rule, so inclusion from
 * rule i onward is defined recursively from the last rule backwards.
 */
function buildExactBooleanLogic(criteriaDecisions: RuleDecisionSummary[]): string | null {
  const build = (idx: number): string | null => {
    if (idx >= criteriaDecisions.length) return null; // fall-through (no decisive rule)
    const decision = criteriaDecisions[idx];
    const atom = `(${decision.clauseTextRaw})`;
    const rest = build(idx + 1);
    const { passAction, failAction } = decision;

    if (passAction === 'Include' && failAction === 'Exclude') return atom;
    if (passAction === 'Exclude' && failAction === 'Include') return `NOT ${atom}`;
    if (passAction === 'Include' && failAction === 'Next rule') return rest ? `${atom} OR (${rest})` : atom;
    if (passAction === 'Next rule' && failAction === 'Exclude') return rest ? `${atom} AND (${rest})` : atom;
    if (passAction === 'Exclude' && failAction === 'Next rule') return rest ? `NOT ${atom} AND (${rest})` : `NOT ${atom}`;
    if (passAction === 'Next rule' && failAction === 'Include') return rest ? `NOT ${atom} OR (${rest})` : `NOT ${atom}`;
    return rest; // informational — does not affect inclusion
  };
  return build(0);
}

function buildAgentInterpretation(report: EmisReport, allReports: EmisReport[]) {
  const decisionFlow = buildDecisionFlow(report, allReports);
  const criteriaDecisions = decisionFlow.filter((decision) => decision.kind === 'criteria-group');

  const clausesOf = (...types: Array<RuleDecisionSummary['clauseType']>) =>
    criteriaDecisions
      .filter((decision) => types.includes(decision.clauseType))
      .map((decision) => decision.clauseTextRaw);

  const requiredClauses = clausesOf('must-match');
  const excludedClauses = clausesOf('must-not-match');
  // OR-cascade rules plus a final include-if-match form one "any of" chain
  const anyOfClauses = clausesOf('include-if-match-else-next', 'include-if-match');
  // NOT-cascade: a patient is included when they fail any one of these
  const notAllClauses = clausesOf('include-if-not-match-else-next', 'include-if-not-match');

  const summaryParts = [
    `Start with ${describeStartingPopulation(report, allReports)}.`,
  ];
  if (requiredClauses.length > 0) {
    summaryParts.push(`Require ${requiredClauses.map((clause) => toSentenceCase(clause)).join('; ')}.`);
  }
  if (excludedClauses.length > 0) {
    summaryParts.push(`Exclude patients who match ${excludedClauses.map((clause) => toSentenceCase(clause)).join('; ')}.`);
  }
  if (anyOfClauses.length === 1) {
    summaryParts.push(`Include patients who match ${toSentenceCase(anyOfClauses[0])}.`);
  } else if (anyOfClauses.length > 1) {
    summaryParts.push(`Include patients who match any of: ${anyOfClauses.map((clause) => toSentenceCase(clause)).join('; OR ')}.`);
  }
  if (notAllClauses.length === 1) {
    summaryParts.push(`Include patients who do not match ${toSentenceCase(notAllClauses[0])}.`);
  } else if (notAllClauses.length > 1) {
    summaryParts.push(`Include patients who fail to match any one of: ${notAllClauses.map((clause) => toSentenceCase(clause)).join('; ')}. (Only patients matching all of these miss this inclusion route.)`);
  }

  return {
    decisionFlow,
    sameColumnConjunctions: decisionFlow.flatMap((decision) => {
      const collect = (criterion: CriterionLogicSummary): SameColumnConjunction[] => [
        ...criterion.sameColumnConjunctions,
        ...criterion.linkedCriteria.flatMap(collect),
        ...criterion.nestedGroups.flatMap((group) => group.criteria.flatMap(collect)),
      ];
      return decision.criteriaDetails.flatMap(collect);
    }),
    dependencies: buildDependencies(report, allReports),
    inclusionCriteria: [...requiredClauses, ...anyOfClauses],
    exclusionCriteria: excludedClauses,
    booleanLogic: buildExactBooleanLogic(criteriaDecisions),
    plainEnglishSummary: summaryParts.join(' '),
  };
}

function buildParentChain(report: EmisReport, allReports: EmisReport[]): ParentChainEntry[] {
  const chain: ParentChainEntry[] = [];
  const seen = new Set<string>();
  let current = report;

  while (current.parentType === 'POP' && current.parentReportId) {
    const parent = allReports.find((candidate) => candidate.xmlId === current.parentReportId);
    if (!parent || seen.has(parent.id)) {
      break;
    }
    seen.add(parent.id);
    const friendlyNameMap = buildFriendlyNameMap(parent);
    const uniqueValueSets = getUniqueValueSets(parent).map((vs) => buildValueSetSummary(vs, friendlyNameMap));
    const interpretation = buildAgentInterpretation(parent, allReports);
    chain.push({
      id: parent.id,
      xmlId: parent.xmlId,
      title: parent.name,
      searchName: parent.searchName,
      parentPopulation: getParentPopulation(parent, allReports),
      plainEnglishSummary: interpretation.plainEnglishSummary,
      booleanLogic: interpretation.booleanLogic,
      referencedSearches: [...new Set(interpretation.dependencies.populationCriteriaReports.map((ref) => ref.searchName))],
      unresolvedLibraryItemRefs: interpretation.dependencies.libraryItemRefs,
      unresolvedLibraryItems: interpretation.dependencies.libraryItems,
      valueSets: uniqueValueSets.map((vs) => ({
        friendlyName: vs.friendlyName,
        preview: vs.preview,
        codeSystem: vs.codeSystem,
        cluster: vs.cluster,
        codeCount: vs.codeCount,
        hash: shortValueSetHash(vs),
      })),
    });
    current = parent;
  }

  return chain;
}

// === Human-readable implementation guide ===

const TABLE_LABELS: Record<string, string> = {
  EVENTS: 'clinical events',
  MEDICATION_ISSUES: 'medication issues',
  MEDICATION_COURSES: 'medication courses',
  PATIENTS: 'patient details',
  REGISTRATION: 'registration details',
};

const COLUMN_LABELS: Record<string, string> = {
  READCODE: 'code',
  SNOMEDCODE: 'code',
  DRUGCODE: 'drug code',
  NUMERIC_VALUE: 'numeric value',
  VALUE: 'value',
  DATE: 'date',
  AGE: 'age',
  AGE_AT_EVENT: 'age at event',
  DOB: 'date of birth',
  GMS_DATE_OF_REGISTRATION: 'registration date',
  GMS_REGISTRATION_DATE: 'registration date',
  EPISODE: 'episode type',
  ISSUE_DATE: 'issue date',
  STATUS: 'course status',
  RX_TYPE: 'prescription type',
};

function tableLabel(table: string): string {
  return TABLE_LABELS[table?.toUpperCase()] || table?.toLowerCase() || 'records';
}

function columnLabel(column: string): string {
  return COLUMN_LABELS[column?.toUpperCase()] || column?.replace(/_/g, ' ').toLowerCase() || '';
}

function describeValueSetRef(vs: ValueSetSummary): string {
  const preview = vs.preview.length > 120 ? `${vs.preview.slice(0, 117)}...` : vs.preview;
  const detail = vs.cluster ? `, cluster ${vs.cluster}` : vs.codeCount <= 3 ? `, ${preview}` : '';
  return `\`${vs.friendlyName}\` (${vs.codeCount} code${vs.codeCount === 1 ? '' : 's'}${detail})`;
}

const UNIT_WORDS: Record<string, string> = {
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  QUARTER: 'quarter',
  YEAR: 'year',
  FISCALYEAR: 'fiscal year',
};

function isEnumValueSet(vs: ValueSetSummary): boolean {
  return vs.codeSystem === 'Internal';
}

function filterLabel(filter: Pick<CriterionFilterSummary, 'columns' | 'displayName'>): string {
  const column = (filter.columns[0] || '').toUpperCase();
  if (COLUMN_LABELS[column]) return COLUMN_LABELS[column];
  // Prefer the XML display name ("Date Drug Added") over a raw column fallback,
  // dropping any parenthetical hint ("Episode (First, New...)" -> "episode")
  if (filter.displayName) return filter.displayName.replace(/\s*\(.*\)\s*$/, '').toLowerCase();
  return columnLabel(column);
}

/** "REVIEW" → "Review"; short codes like "RD" stay as-is */
function prettifyEnumValue(code: string): string {
  if (code.length <= 2 || !/^[A-Z]+$/.test(code)) return code;
  return code.charAt(0) + code.slice(1).toLowerCase();
}

/** "Date IN within the last 1 year" → "date within the last 1 year" */
function humanFilter(filter: CriterionFilterSummary): string {
  const label = filterLabel(filter);
  const notIn = filter.operator?.toUpperCase() === 'NOTIN';
  if (filter.valueSets.length > 0) {
    // Enum labels belong to their filter, rather than the code-list appendix.
    if (filter.valueSets.every(isEnumValueSet)) {
      const values = (vs: ValueSetSummary) => vs.codes.map((code) => code.displayName || prettifyEnumValue(code.code)).join(', ');
      if (filter.valueSets.length === 1 && !filter.valueSets[0].isAllValuesExcept) {
        return `${label}${notIn ? ' not in' : ''}: ${values(filter.valueSets[0])}`;
      }
      return `${label} ${formatValueSetCondition(filter.valueSets, notIn, values)}`;
    }
    return `${label} ${formatValueSetCondition(filter.valueSets, notIn, describeValueSetRef)}`;
  }
  const value = filter.range?.rendered || filter.singleValue || '';
  if (!value) return label;
  return `${label} ${notIn ? 'not ' : ''}${humanizeRawTemporal(value, filter.columns[0])}`.trim();
}

/** "DATE at least 93 days before ... parent record's DATE" → "its date at least 93 days before ... the date of the record above" */
function humanRelationship(relationship: RelationshipSummary): string {
  let text = relationship.rendered;
  text = text.replace(/parent record's\s+([A-Z_]+)/i, (_, col) => `the ${columnLabel(col)} of the record above`);
  text = text.replace(/^([A-Z_]+)\s/, (_, col) => `its ${columnLabel(col)} `);
  return text;
}

// --- Symbolic operator rendering (exact forms for implementers) ---

function symbolicKind(column: string): 'numeric' | 'age' | 'date' {
  const col = column.toUpperCase();
  if (col === 'AGE' || col === 'AGE_AT_EVENT') return 'age';
  if (col.startsWith('NUMERIC_VALUE') || col === 'VALUE') return 'numeric';
  return 'date';
}

function symbolicBoundary(boundary: RangeBoundarySummary, kind: 'numeric' | 'age' | 'date'): string | null {
  if (!boundary.operatorSymbol || boundary.value === null) return null;
  if (boundary.relation?.toUpperCase() === 'ABSOLUTE') return boundary.value;
  if (['Last', 'This', 'Next'].includes(boundary.value)) return null; // named periods have no clean symbolic form

  if (kind === 'numeric') return boundary.value;

  const num = parseInt(boundary.value, 10);
  if (isNaN(num)) return null;
  const unit = boundary.unit
    ? (UNIT_WORDS[boundary.unit.toUpperCase()] || boundary.unit.toLowerCase()) + (Math.abs(num) === 1 ? '' : 's')
    : '';

  if (kind === 'age') return unit ? `${Math.abs(num)} ${unit}` : boundary.value;

  if (num === 0) return 'today';
  if (!unit) return boundary.value;
  return num < 0 ? `today - ${Math.abs(num)} ${unit}` : `today + ${num} ${unit}`;
}

/** "within the last 12 months" gains an exact form: `date >= today - 12 months` */
function symbolicRange(range: DateRangeSummary | null, column: string): string | null {
  if (!range) return null;
  const kind = symbolicKind(column);
  const token = columnLabel(column) || 'value';
  const parts: string[] = [];
  for (const boundary of [range.from, range.to]) {
    if (!boundary) continue;
    const value = symbolicBoundary(boundary, kind);
    if (!value) return null; // only emit a symbolic form when every boundary has one
    parts.push(`${token} ${boundary.operatorSymbol} ${value}`);
  }
  return parts.length > 0 ? parts.join(' AND ') : null;
}

function symbolicRestriction(restriction: CriterionRestrictionSummary): string | null {
  const parts: string[] = [];
  for (const condition of restriction.conditions) {
    if (condition.rangeValues.length === 0) continue;
    const token = columnLabel(condition.column) || condition.column.toLowerCase();
    parts.push(condition.rangeValues.map((value) => `${token} ${value}`.replace(/\s+/g, ' ')).join(' AND '));
  }
  return parts.length > 0 ? parts.join(' AND ') : null;
}

// --- Labelled block renderer ---

interface GuideRenderContext {
  /** friendlyName -> rule labels that reference it */
  usedInRules: Map<string, Set<string>>;
  /** runtime parameter names found anywhere in the rules */
  parameters: Set<string>;
  currentRuleLabel: string;
}

function recordValueSetUse(ctx: GuideRenderContext, vs: ValueSetSummary) {
  if (vs.isAllValuesExcept || vs.friendlyName === '(not assigned)') return;
  if (!ctx.usedInRules.has(vs.friendlyName)) ctx.usedInRules.set(vs.friendlyName, new Set());
  ctx.usedInRules.get(vs.friendlyName)!.add(ctx.currentRuleLabel);
}

function operatorBadge(operator: string | null | undefined): string {
  return operator === 'OR' ? '**ANY (OR)**' : '**ALL (AND)**';
}

/**
 * Renders one criterion as a labelled block. Children (nested-group members
 * and linked records) are labelled `<label>.<n>` so deep chains stay traceable.
 */
function renderCriterionBlock(
  lines: string[],
  criterion: CriterionLogicSummary,
  label: string,
  kind: 'criterion' | 'member' | 'linked',
  ctx: GuideRenderContext,
  indent = '',
  parentLabel = '',
) {
  const tableText = tableLabel(criterion.table);
  const tableSuffix = criterion.displayName.toLowerCase() === tableText ? '' : ` (${tableText})`;
  const negationText = criterion.negation ? ' — must NOT exist' : '';

  if (kind === 'linked') {
    let joinText = `linked to record ${parentLabel}`;
    if (criterion.relationship) {
      const rendered = humanRelationship(criterion.relationship);
      const linkedOn = rendered.match(/^Linked on ([A-Z_]+)$/i);
      joinText = linkedOn
        ? `same ${columnLabel(linkedOn[1])} as record ${parentLabel}`
        : rendered.replace(/the record above/g, `record ${parentLabel}`);
    }
    lines.push(`${indent}- **Linked record ${label}**${negationText} — join: ${joinText}`);
  } else {
    const kindWord = kind === 'member' ? '' : 'Criterion ';
    lines.push(`${indent}- **${kindWord}${label} — ${criterion.displayName}**${tableSuffix}${negationText}`);
  }
  if (criterion.description) {
    lines.push(`${indent}  *"${criterion.description}"*`);
  }

  const filterGroups: CriterionFilterSummary[][] = [];
  for (const filter of criterion.filters) {
    const previousGroup = filterGroups[filterGroups.length - 1];
    const previous = previousGroup?.[0];
    if (filter.range && previous?.range && filter.operator === 'IN' && previous.operator === 'IN'
      && filter.columns.join(',') === previous.columns.join(',')) {
      previousGroup.push(filter);
    } else {
      filterGroups.push([filter]);
    }
  }
  let filterCount = 0;
  for (const [filter, ...otherBounds] of filterGroups) {
    filter.valueSets.forEach((vs) => recordValueSetUse(ctx, vs));
    if (filter.parameter) ctx.parameters.add(filter.parameter.name);
    const conjunction = filterCount > 0 ? 'AND ' : 'Where ';
    if (filter.parameter) {
      lines.push(`${indent}  - ${conjunction}${filterLabel(filter)} matches the runtime parameter \`${filter.parameter.name}\` (prompted when the search runs)`);
      filterCount++;
      continue;
    }
    // Skip filters that carry no condition (operator-only boundaries render empty)
    const rendered = [humanFilter(filter), ...otherBounds.map((bound) => bound.range?.rendered)].filter(Boolean).join(' AND ');
    if (!rendered || rendered === filterLabel(filter)) continue;
    // Only add the symbolic form when it says more than the words already do
    const symbolic = [filter, ...otherBounds].map((bound) => symbolicRange(bound.range, bound.columns[0] || '')).filter(Boolean).join(' AND ');
    const addSymbolic = symbolic && !rendered.includes(symbolic);
    lines.push(`${indent}  - ${conjunction}${rendered}${addSymbolic ? `, \`${symbolic}\`` : ''}`);
    filterCount++;
  }
  for (const warning of criterion.sameColumnConjunctions) {
    lines.push(`${indent}  - ${formatSameColumnConjunction(warning)}`);
  }

  for (const restriction of criterion.restrictions) {
    const words = restriction.rendered;
    const symbolic = symbolicRestriction(restriction);
    const addSymbolic = symbolic && !words.includes(symbolic);
    lines.push(`${indent}  - ${words}${addSymbolic ? `, \`${symbolic}\`` : ''}`);
  }
  // Test sets check the kept record's code; they are not the criterion's code list
  const testValueSets = criterion.restrictionValueSets.filter((vs) => !isEnumValueSet(vs));
  testValueSets.forEach((vs) => recordValueSetUse(ctx, vs));
  if (testValueSets.length > 0) {
    lines.push(`${indent}  - Restriction test sets (applied after record selection): ${testValueSets.map((vs) => `${describeValueSetRef(vs)}${testOperatorSuffix(vs)}`).join('; ')}`);
  }

  let childIndex = 0;
  for (const group of criterion.nestedGroups) {
    lines.push(`${indent}  - Requires this group — ${operatorBadge(group.operator)} of the following:`);
    for (const member of group.criteria) {
      childIndex++;
      renderCriterionBlock(lines, member, `${label}.${childIndex}`, 'member', ctx, `${indent}    `, label);
    }
  }
  for (const linked of criterion.linkedCriteria) {
    childIndex++;
    renderCriterionBlock(lines, linked, `${label}.${childIndex}`, 'linked', ctx, `${indent}  `, label);
  }
}

function ruleFlowSentence(
  clauseType: RuleDecisionSummary['clauseType'],
  ruleNumber: number,
  totalRules: number,
): string {
  const next = ruleNumber < totalRules ? `Rule ${ruleNumber + 1}` : 'the next rule';
  switch (clauseType) {
    case 'include-if-match-else-next':
      return `If a patient matches this rule they are **included** and no further rules are checked. If not, continue to ${next}.`;
    case 'must-match':
      return `Patients **must match** this rule to stay in. Those who match continue to ${next}; those who do not are excluded.`;
    case 'must-not-match':
      return `Patients matching this rule are **excluded** and no further rules are checked. Everyone else continues to ${next}.`;
    case 'include-if-not-match-else-next':
      return `If a patient does **not** match this rule they are **included** and no further rules are checked. If they do match, continue to ${next}.`;
    case 'include-if-match':
      return 'Final rule: patients who match are **included**; everyone else is excluded.';
    case 'include-if-not-match':
      return 'Final rule: patients who match are **excluded**; everyone else is included.';
    default:
      return 'This rule does not change who is included.';
  }
}

/** Collects every ValueSet referenced by a report's rules, deduped by friendly name */
function collectReferencedValueSets(report: EmisReport): ValueSetSummary[] {
  const friendlyNameMap = buildFriendlyNameMap(report);
  const byName = new Map<string, ValueSetSummary>();

  const addVs = (vs: EmisValueSet) => {
    if (vs.isAllValuesExcept) return; // exclusion filters are not code lists
    const summary = buildValueSetSummary(vs, friendlyNameMap);
    if (!byName.has(summary.friendlyName)) {
      byName.set(summary.friendlyName, summary);
    }
  };
  const visit = (criteria: SearchCriterion[]) => {
    for (const criterion of criteria) {
      criterion.valueSets.forEach(addVs);
      for (const filter of criterion.columnFilters) {
        (filter.valueSets ?? []).forEach(addVs);
      }
      visit(criterion.linkedCriteria);
    }
  };
  for (const group of report.criteriaGroups ?? []) visit(group.criteria);
  for (const group of report.columnGroups ?? []) visit(group.criteria);
  report.valueSets.forEach(addVs);

  return Array.from(byName.values()).sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));
}

function shortValueSetHash(summary: ValueSetSummary): string {
  return generateValueSetHash(summary.codes.map((code) => code.code).sort()).substring(0, 8);
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// Mark only exclusion tests; inclusion is the default reading
function testOperatorSuffix(vs: { testOperators?: string[] }): string {
  const ops = (vs.testOperators ?? []).filter((op) => op !== 'IN');
  return ops.length > 0 ? ` [${ops.join(', ')}]` : '';
}

export function buildImplementationGuideMarkdown(report: EmisReport, allReports: EmisReport[]): string {
  const currentSummary = buildAgentInterpretation(report, allReports);
  const parentChain = buildParentChain(report, allReports);
  const lines: string[] = [];

  const folderPath = report.rule.split(' > ').slice(1).join(' > ');
  const sourceFile = report.rule.split(' > ')[0] || '';

  lines.push(`# ${report.searchName}`);
  lines.push('');
  if (report.searchName !== report.name) lines.push(`Report title: ${report.name}`);
  if (folderPath) lines.push(`Folder: ${folderPath}`);
  if (sourceFile) lines.push(`Source: ${sourceFile}`);
  if (report.description) lines.push(`Description: ${report.description}`);
  lines.push('');

  // --- Overview ---
  lines.push('## What this search does');
  lines.push('');
  const criteriaRules = currentSummary.decisionFlow.filter((rule) => rule.kind === 'criteria-group');
  const overview: string[] = [`Start with ${describeStartingPopulation(report, allReports)}${parentChain.length > 0 ? ' (see below)' : ''}.`];

  const ruleNumbersOf = (type: RuleDecisionSummary['clauseType']) =>
    criteriaRules
      .map((rule, idx) => ({ rule, n: idx + 1 }))
      .filter(({ rule }) => rule.clauseType === type)
      .map(({ n }) => n);

  const mustNumbers = ruleNumbersOf('must-match');
  const excludeNumbers = ruleNumbersOf('must-not-match');
  const anyOfNumbers = [...ruleNumbersOf('include-if-match-else-next'), ...ruleNumbersOf('include-if-match')].sort((a, b) => a - b);
  const notAllNumbers = [...ruleNumbersOf('include-if-not-match-else-next'), ...ruleNumbersOf('include-if-not-match')].sort((a, b) => a - b);

  const listRules = (numbers: number[]) => {
    if (numbers.length === 1) return `Rule ${numbers[0]}`;
    // Compress consecutive runs: [1,2,3,4,6] -> "Rules 1-4 and 6"
    const runs: string[] = [];
    let start = numbers[0];
    let prev = numbers[0];
    for (const n of [...numbers.slice(1), NaN]) {
      if (n === prev + 1) {
        prev = n;
        continue;
      }
      runs.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = n;
      prev = n;
    }
    return `Rules ${runs.join(', ').replace(/, ([^,]+)$/, ' and $1')}`;
  };

  if (mustNumbers.length > 0) overview.push(`Patients must match ${listRules(mustNumbers)} to stay in.`);
  if (excludeNumbers.length > 0) overview.push(`Patients matching ${listRules(excludeNumbers)} are excluded.`);
  if (anyOfNumbers.length === 1) overview.push(`A patient is included when they match ${listRules(anyOfNumbers)}.`);
  if (anyOfNumbers.length > 1) overview.push(`A patient is included when they match any one of ${listRules(anyOfNumbers)}.`);
  if (notAllNumbers.length === 1) overview.push(`A patient is included when they do NOT match ${listRules(notAllNumbers)}.`);
  if (notAllNumbers.length > 1) overview.push(`A patient is included unless they match every one of ${listRules(notAllNumbers)} — failing any one of them includes the patient.`);
  if (criteriaRules.length > 1) overview.push('Rules run in order; each patient stops at the first rule that includes or excludes them.');
  if (criteriaRules.length === 0) overview.push('This report has no filtering rules of its own — it reports on its starting population.');
  lines.push(overview.join(' '));
  lines.push('');

  // --- Start population (dependency chain) ---
  lines.push('## Start population');
  lines.push('');
  if (parentChain.length === 0) {
    lines.push(`${getParentPopulation(report, allReports)}.`);
  } else {
    const ordered = parentChain.slice().reverse(); // base population first
    lines.push(`1. ${ordered[0].parentPopulation}`);
    ordered.forEach((parent, idx) => {
      // The leading "Start with..." sentence repeats the previous chain step
      const gist = parent.plainEnglishSummary.replace(/^Start with [^.]*\.\s*/, '') || 'No additional filtering.';
      lines.push(`${idx + 2}. **${parent.searchName}** — ${gist}`);
      if (parent.referencedSearches.length > 0) {
        lines.push(`   - Combines: ${parent.referencedSearches.map((name) => `**${name}**`).join('; ')}`);
      }
    });
    lines.push(`${ordered.length + 2}. **This search** — applies the rules below.`);
  }
  lines.push('');

  // --- Rule flow table ---
  const ruleRole = (clauseType: RuleDecisionSummary['clauseType']): string => {
    switch (clauseType) {
      case 'must-match': return 'Filter — must match';
      case 'must-not-match': return 'Exclusion';
      case 'include-if-match-else-next': return 'Inclusion route';
      case 'include-if-not-match-else-next': return 'Inclusion route (on no match)';
      case 'include-if-match': return 'Final — include if matched';
      case 'include-if-not-match': return 'Final — exclude if matched';
      default: return 'No effect on inclusion';
    }
  };
  const actionCell = (action: string, ruleNumber: number): string => {
    if (action === 'Include') return '**Included**';
    if (action === 'Exclude') return 'Excluded';
    if (action === 'Next rule') return `Continue to Rule ${ruleNumber + 1}`;
    return action;
  };

  if (criteriaRules.length > 0) {
    lines.push('## Rule flow');
    lines.push('');
    lines.push('| Rule | If patient matches | If patient does not match | Role |');
    lines.push('| --- | --- | --- | --- |');
    criteriaRules.forEach((rule, idx) => {
      const n = idx + 1;
      lines.push(`| ${n} | ${actionCell(rule.passAction, n)} | ${actionCell(rule.failAction, n)} | ${ruleRole(rule.clauseType)} |`);
    });
    lines.push('');
  }

  // --- Rule details ---
  const ctx: GuideRenderContext = {
    usedInRules: new Map(),
    parameters: new Set(),
    currentRuleLabel: '',
  };

  lines.push('## Rule details');
  lines.push('');
  if (criteriaRules.length === 0) {
    lines.push('No rules — all patients from the starting population are included.');
    lines.push('');
  }
  criteriaRules.forEach((rule, idx) => {
    const n = idx + 1;
    ctx.currentRuleLabel = `${n}`;
    lines.push(`### Rule ${n} of ${criteriaRules.length} — ${ruleRole(rule.clauseType)}`);
    lines.push('');
    lines.push(ruleFlowSentence(rule.clauseType, n, criteriaRules.length));
    lines.push('');

    const parts = rule.criteriaDetails.length + rule.populationCriteria.length + rule.libraryItems.length;
    if (parts > 1) {
      lines.push(`A patient matches this rule when ${operatorBadge(rule.operator)} of the following are true:`);
    } else if (parts === 1) {
      lines.push('A patient matches this rule when:');
    }
    lines.push('');
    for (const population of rule.populationCriteria) {
      lines.push(`- They appear in the results of the search **${population.searchName}**`);
    }
    for (const libraryItem of rule.libraryItems) {
      const name = libraryItem.inferredName ? `**${libraryItem.inferredName}**` : `\`${libraryItem.ref}\``;
      lines.push(`- They match the EMIS library item ${name} (see Caveats)`);
    }
    rule.criteriaDetails.forEach((criterion, criterionIdx) => {
      renderCriterionBlock(lines, criterion, String.fromCharCode(65 + (criterionIdx % 26)), 'criterion', ctx);
    });
    lines.push('');
  });

  // --- Report output columns ---
  const columnRules = currentSummary.decisionFlow.filter((rule) => rule.kind === 'column-group');
  if (columnRules.length > 0) {
    lines.push('## Report output');
    lines.push('');
    lines.push('These define what the report shows for each patient, not who is included.');
    lines.push('');
    for (const rule of columnRules) {
      ctx.currentRuleLabel = rule.label;
      lines.push(`### ${rule.label}`);
      lines.push('');
      if (rule.outputColumns && rule.outputColumns.length > 0) {
        lines.push(`Shows: ${rule.outputColumns.join(', ')}`);
      }
      if (rule.criteriaDetails.length === 0) {
        lines.push('No filtering criteria; outputs standard columns.');
      }
      rule.criteriaDetails.forEach((criterion, criterionIdx) => {
        renderCriterionBlock(lines, criterion, String.fromCharCode(65 + (criterionIdx % 26)), 'criterion', ctx);
      });
      lines.push('');
    }
  }

  // --- Code lists ---
  lines.push('## Code lists used');
  lines.push('');
  const valueSetRows: Array<{ search: string; vs: { friendlyName: string; cluster: string | null; codeSystem: string; codeCount: number; preview: string; hash: string } }> = [];
  for (const parent of parentChain.slice().reverse()) {
    for (const vs of parent.valueSets) {
      valueSetRows.push({ search: parent.searchName, vs });
    }
  }
  for (const summary of collectReferencedValueSets(report)) {
    valueSetRows.push({
      search: report.searchName,
      vs: {
        friendlyName: summary.friendlyName,
        cluster: summary.cluster,
        codeSystem: summary.codeSystem,
        codeCount: summary.codeCount,
        preview: summary.preview,
        hash: shortValueSetHash(summary),
      },
    });
  }
  if (valueSetRows.length === 0) {
    lines.push('None.');
  } else {
    lines.push('Names below match `valueset_friendly_name` in the extraction CSVs. The hash identifies the exact code list content, so a changed hash means the codes changed.');
    lines.push('');
    lines.push('| Search | Code list | Cluster | Used in rules | System | Codes | Content | Hash |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const row of valueSetRows) {
      const preview = row.vs.preview.length > 80 ? `${row.vs.preview.substring(0, 77)}...` : row.vs.preview;
      const usedIn = row.search === report.searchName
        ? [...(ctx.usedInRules.get(row.vs.friendlyName) ?? [])].join(', ')
        : '';
      lines.push(`| ${escapeTableCell(row.search)} | \`${row.vs.friendlyName}\` | ${escapeTableCell(row.vs.cluster || '')} | ${usedIn} | ${row.vs.codeSystem} | ${row.vs.codeCount} | ${escapeTableCell(preview)} | ${row.vs.hash} |`);
    }
  }
  lines.push('');

  // --- Caveats ---
  lines.push('## Caveats');
  lines.push('');
  const caveats: string[] = [];
  const libraryCaveat = (searchName: string, item: LibraryItemReferenceSummary) => {
    const inferred = item.inferredName
      ? ` It is likely **${item.inferredName}** (inferred from wrapper report${item.wrapperReports.length === 1 ? '' : 's'} ${item.wrapperReports.map((wrapper) => `"${wrapper.searchName}"`).join(', ')}), but this is not certain.`
      : '';
    return `${searchName} references the EMIS library item \`${item.ref}\`, whose logic is not included in this XML export.${inferred} Verify it in EMIS before implementing.`;
  };
  for (const parent of parentChain.slice().reverse()) {
    for (const item of parent.unresolvedLibraryItems) caveats.push(libraryCaveat(parent.searchName, item));
  }
  for (const item of currentSummary.dependencies.libraryItems) caveats.push(libraryCaveat('This search', item));
  for (const parameterName of [...ctx.parameters].sort()) {
    caveats.push(`This search prompts for the runtime parameter \`${parameterName}\` when run — results depend on the value entered.`);
  }
  const hasExceptions = report.valueSets.some((vs) => vs.exceptions.length > 0);
  if (hasExceptions) {
    caveats.push('Some code lists exclude specific codes. See `exceptions.csv` in the extraction for the excluded codes and whether each was applied.');
  }
  caveats.push('This guide is generated from the EMIS XML export. Validate it against the source search in EMIS before implementing.');
  for (const caveat of caveats) {
    lines.push(`- ${caveat}`);
  }

  return lines.join('\n').trim();
}

function buildLibraryItemSearchText(report: EmisReport, allReports: EmisReport[]): string {
  const parts: string[] = [];
  for (const group of report.criteriaGroups ?? []) {
    for (const ref of group.libraryItemRefs ?? []) {
      const summary = buildLibraryItemReferenceSummary(ref, allReports);
      parts.push(ref);
      parts.push(summary.inferredName || '');
      for (const wrapper of summary.wrapperReports) {
        parts.push(wrapper.searchName);
        parts.push(wrapper.title);
      }
    }
  }
  return parts.join(' ').toLowerCase();
}

export function buildReportSearchText(report: EmisReport, allReports: EmisReport[]): string {
  const friendlyNameMap = buildFriendlyNameMap(report);
  const criteriaText = [
    ...(report.criteriaGroups ?? []).map((group) => buildCriteriaSearchText(group.criteria)),
    ...(report.columnGroups ?? []).map((group) => buildCriteriaSearchText(group.criteria)),
  ].join(' ');
  const valueSetText = getUniqueValueSets(report)
    .map((vs) => [
      friendlyNameMap.get(vs.id) || '',
      formatValueSetPreview(vs),
      vs.description || '',
      vs.values.map((value) => value.displayName).join(' '),
      vs.values.map((value) => value.code).join(' '),
    ].join(' '))
    .join(' ');

  return [
    report.id,
    report.xmlId,
    report.name,
    report.searchName,
    report.description || '',
    report.rule,
    report.reportType,
    getParentPopulation(report, allReports),
    criteriaText,
    valueSetText,
    buildLibraryItemSearchText(report, allReports),
  ].join(' ').toLowerCase();
}

export function buildReportLogicSummary(report: EmisReport, allReports: EmisReport[]) {
  const friendlyNameMap = buildFriendlyNameMap(report);
  const counts = getReportCounts(report);
  const uniqueValueSets = getUniqueValueSets(report);
  const agentInterpretation = buildAgentInterpretation(report, allReports);
  const parentChain = buildParentChain(report, allReports);
  return {
    id: report.id,
    xmlId: report.xmlId,
    title: report.name,
    searchName: report.searchName,
    description: report.description || null,
    folderPath: report.rule,
    reportType: report.reportType,
    parentPopulation: getParentPopulation(report, allReports),
    counts,
    agentInterpretation,
    parentChain,
    valueSets: uniqueValueSets.map((vs) => buildValueSetSummary(vs, friendlyNameMap)),
    logicMarkdown: buildRulesMarkdown(report, allReports),
    implementationGuideMarkdown: buildImplementationGuideMarkdown(report, allReports),
  };
}

export function buildReportIndexEntry(report: EmisReport, allReports: EmisReport[]) {
  const dependencies = buildDependencies(report, allReports);
  return {
    id: report.id,
    xmlId: report.xmlId,
    title: report.name,
    searchName: report.searchName,
    description: report.description || null,
    folderPath: report.rule,
    reportType: report.reportType,
    parentPopulation: getParentPopulation(report, allReports),
    counts: getReportCounts(report),
    libraryItems: dependencies.libraryItems,
  };
}

export function buildDocumentGraph(reports: EmisReport[]) {
  const nodes: Array<{ id: string; type: string; label: string; metadata?: Record<string, string | number | boolean | null> }> = [];
  const edges: Array<{ from: string; to: string; type: string; label: string }> = [];
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();
  const addNode = (id: string, type: string, label: string, metadata?: Record<string, string | number | boolean | null>) => {
    if (seenNodes.has(id)) return;
    seenNodes.add(id);
    nodes.push({ id, type, label, metadata });
  };
  const addEdge = (from: string, to: string, type: string, label: string) => {
    const key = `${from}|${to}|${type}|${label}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from, to, type, label });
  };

  for (const report of reports) {
    const friendlyNameMap = buildFriendlyNameMap(report);
    addNode(`report:${report.id}`, 'report', report.searchName, {
      title: report.name,
      folderPath: report.rule,
      reportType: report.reportType,
    });

    if (report.parentType === 'POP' && report.parentReportId) {
      const parent = reports.find((candidate) => candidate.xmlId === report.parentReportId);
      const parentNodeId = parent ? `report:${parent.id}` : `external-report:${report.parentReportId}`;
      addNode(parentNodeId, parent ? 'report' : 'external-report', parent?.searchName || report.parentReportId);
      addEdge(`report:${report.id}`, parentNodeId, 'parent-population', 'parent population');
    }

    const addCriteriaEdges = (criteria: SearchCriterion[]) => {
      for (const criterion of criteria) {
        for (const vs of criterion.valueSets) {
          addNode(`valueset:${vs.id}`, 'valueset', friendlyNameMap.get(vs.id) || vs.id, {
            codeCount: vs.values.length,
            cluster: vs.description || null,
          });
          addEdge(`report:${report.id}`, `valueset:${vs.id}`, 'uses-valueset', criterion.displayName || criterion.table);
        }
        for (const linked of criterion.linkedCriteria) addCriteriaEdges([linked]);
      }
    };

    for (const group of report.criteriaGroups ?? []) {
      for (const populationRef of group.populationCriteria) {
        const target = reports.find((candidate) => candidate.xmlId === populationRef.reportGuid);
        const targetNodeId = target ? `report:${target.id}` : `external-report:${populationRef.reportGuid}`;
        addNode(targetNodeId, target ? 'report' : 'external-report', target?.searchName || populationRef.reportGuid);
        addEdge(`report:${report.id}`, targetNodeId, 'population-criteria', 'patients included in search');
      }
        for (const libraryRef of group.libraryItemRefs ?? []) {
          const libraryNodeId = `library-item:${libraryRef}`;
        const summary = buildLibraryItemReferenceSummary(libraryRef, reports);
        addNode(libraryNodeId, 'library-item', summary.inferredName || libraryRef, {
          ref: libraryRef,
          inferredName: summary.inferredName,
          wrapperReportCount: summary.wrapperReports.length,
        });
        addEdge(`report:${report.id}`, libraryNodeId, 'library-item', 'library item ref');
      }
      addCriteriaEdges(group.criteria);
    }

    for (const group of report.columnGroups ?? []) {
      addCriteriaEdges(group.criteria);
    }
  }

  return { nodes, edges };
}
