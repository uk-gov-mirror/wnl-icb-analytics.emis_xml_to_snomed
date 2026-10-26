/**
 * Rule structure parser for EMIS XML.
 * Extracts criteria groups, criteria, restrictions, column filters,
 * linked criteria, and date ranges from the fast-xml-parser JSON tree.
 */

import {
  CriteriaGroup,
  ColumnGroup,
  ListColumn,
  SearchCriterion,
  SearchRestriction,
  RestrictionCondition,
  ColumnFilter,
  DateRange,
  RangeBoundary,
  LinkedRelationship,
  PopulationCriterionRef,
  EmisValueSet,
  MemberOperator,
  RuleAction,
} from './types';
import { parseValueSet } from './xml-parser';

// Normalise any value to an array
function toArray<T>(val: T | T[] | undefined | null): T[] {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

// --- Entry point ---

export function parseCriteriaGroups(populationNode: any): CriteriaGroup[] {
  if (!populationNode) return [];

  const groups: CriteriaGroup[] = [];

  const criteriaGroupNodes = toArray(populationNode.criteriaGroup);
  for (const node of criteriaGroupNodes) {
    const group = parseCriteriaGroup(node);
    if (group) groups.push(group);
  }

  // Handle baseCriteriaGroup at the population level
  const baseGroupNodes = toArray(populationNode.baseCriteriaGroup);
  for (const node of baseGroupNodes) {
    const group = parseCriteriaGroup(node);
    if (group) groups.push(group);
  }

  return groups;
}

// --- CriteriaGroup ---

function parseCriteriaGroup(groupNode: any): CriteriaGroup | null {
  if (!groupNode) return null;

  const definition = groupNode.definition;
  if (!definition) return null;

  const id = groupNode.id || definition.id || '';
  const memberOperator = (definition.memberOperator || 'AND') as MemberOperator;
  const actionIfTrue = (groupNode.actionIfTrue || 'SELECT') as RuleAction;
  const actionIfFalse = (groupNode.actionIfFalse || 'REJECT') as RuleAction;

  // Parse criteria
  const criteria: SearchCriterion[] = [];
  const criteriaContainers = toArray(definition.criteria);

  for (const container of criteriaContainers) {
    const criterionNodes = toArray(container?.criterion);
    for (const critNode of criterionNodes) {
      const criterion = parseCriterion(critNode);
      if (criterion) criteria.push(criterion);
    }
  }

  // Parse population criteria (references to other reports)
  const populationCriteria: PopulationCriterionRef[] = [];
  for (const container of criteriaContainers) {
    const popCritNodes = toArray(container?.populationCriterion);
    for (const pc of popCritNodes) {
      const reportGuid = pc?.['@_reportGuid'] || pc?.reportGuid;
      if (reportGuid) {
        populationCriteria.push({
          id: pc?.['@_id'] || pc?.id || '',
          reportGuid,
        });
      }
    }
  }

  // Parse library item references (external EMIS library definitions)
  const libraryItemRefs: string[] = [];
  for (const container of criteriaContainers) {
    const libNodes = toArray(container?.libraryItem);
    for (const lib of libNodes) {
      // libraryItem can be nested: <libraryItem><libraryItem>UUID</libraryItem></libraryItem>
      const uuid = extractText(lib?.libraryItem ?? lib);
      if (uuid) libraryItemRefs.push(uuid);
    }
  }

  return {
    id,
    memberOperator,
    criteria,
    populationCriteria,
    libraryItemRefs: libraryItemRefs.length > 0 ? libraryItemRefs : undefined,
    actionIfTrue,
    actionIfFalse,
  };
}

// --- Criterion ---

function parseCriterion(node: any): SearchCriterion | null {
  if (!node) return null;

  const id = extractText(node.id);
  const table = extractText(node.table) || 'Unknown';
  const displayName = extractText(node.displayName) || 'Unknown';
  const description = extractText(node.description) || undefined;
  const exceptionCode = extractText(node.exceptionCode) || undefined;

  // Parse negation
  const negationRaw = node.negation;
  const negation = negationRaw === true || negationRaw === 'true';

  // Parse filterAttribute contents
  const filterAttrs = toArray(node.filterAttribute);

  // Value sets from filterAttribute > columnValue > valueSet
  const valueSets = parseValueSetsFromFilterAttrs(filterAttrs);

  // Parse baseCriteriaGroup structurally: the nested criteria carry their own
  // negation, operators, filters, restrictions, and linked criteria. The
  // value sets are also hoisted into this criterion (existing behaviour, which
  // friendly-name numbering depends on).
  const baseGroups = toArray(node.baseCriteriaGroup);
  const baseCriteriaGroups: NonNullable<SearchCriterion['baseCriteriaGroups']> = [];
  for (const bg of baseGroups) {
    const bgDef = bg?.definition;
    if (!bgDef) continue;
    const memberOperator = (extractText(bgDef.memberOperator) || 'AND') as MemberOperator;
    const nestedCriteria: SearchCriterion[] = [];
    const bgCriteriaContainers = toArray(bgDef.criteria);
    for (const container of bgCriteriaContainers) {
      const bgCritNodes = toArray(container?.criterion);
      for (const bgCrit of bgCritNodes) {
        const bgFilterAttrs = toArray(bgCrit?.filterAttribute);
        valueSets.push(...parseValueSetsFromFilterAttrs(bgFilterAttrs));
        const parsed = parseCriterion(bgCrit);
        if (parsed) nestedCriteria.push(parsed);
      }
    }
    if (nestedCriteria.length > 0) {
      baseCriteriaGroups.push({ memberOperator, criteria: nestedCriteria });
    }
  }

  // Column filters
  const columnFilters = parseColumnFiltersFromFilterAttrs(filterAttrs);

  // Restrictions
  const restrictions = parseRestrictionsFromCriterion(node, filterAttrs);
  const valueSetFilters: NonNullable<SearchCriterion['valueSetFilters']> = [];
  const addFilterSets = (filters: ColumnFilter[], source: 'filter' | 'restriction-test') => {
    filters.forEach((filter, index) => {
      if (!filter.valueSets?.length) return;
      for (const column of filter.columns) {
        valueSetFilters.push({
          filterId: filter.id || `${id}:${source}:${index + 1}`,
          column,
          inNotIn: filter.inNotIn,
          source,
          valueSets: filter.valueSets,
        });
      }
    });
  };
  addFilterSets(columnFilters, 'filter');
  restrictions.forEach((restriction, index) => {
    addFilterSets((restriction.testFilters ?? []).map((filter, testIndex) => ({
      ...filter,
      id: filter.id || `${id}:restriction:${index + 1}:test:${testIndex + 1}`,
    })), 'restriction-test');
  });

  // Linked criteria
  const linkedCriteria = parseLinkedCriteria(node);

  return {
    id,
    table,
    displayName,
    description,
    negation,
    valueSets,
    columnFilters,
    valueSetFilters,
    restrictions,
    exceptionCode,
    linkedCriteria,
    ...(baseCriteriaGroups.length > 0 ? { baseCriteriaGroups } : {}),
  };
}

// --- Value Sets ---

function parseValueSetsFromFilterAttrs(filterAttrs: any[]): EmisValueSet[] {
  const valueSets: EmisValueSet[] = [];
  const seen = new Set<string>();

  for (const fa of filterAttrs) {
    if (!fa) continue;

    // columnValue > valueSet
    const columnValues = toArray(fa.columnValue);
    for (const cv of columnValues) {
      if (!cv?.valueSet) continue;
      const vsNodes = toArray(cv.valueSet);
      for (const vs of vsNodes) {
        addValueSet(vs, valueSets, seen);
      }
    }

    // restriction > testAttribute > columnValue > valueSet
    const restrictions = toArray(fa.restriction);
    for (const r of restrictions) {
      const testAttrs = toArray(r?.testAttribute);
      for (const ta of testAttrs) {
        const taCols = toArray(ta?.columnValue);
        for (const tc of taCols) {
          if (!tc?.valueSet) continue;
          const vsNodes = toArray(tc.valueSet);
          for (const vs of vsNodes) {
            addValueSet(vs, valueSets, seen, true);
          }
        }
      }
    }
  }

  return valueSets;
}

function addValueSet(vsNode: any, out: EmisValueSet[], seen: Set<string>, isRestrictionTest = false) {
  const parsed = parseValueSet(vsNode, out.length);
  if (parsed && isRestrictionTest) parsed.isRestrictionTest = true;
  // Exclusion-style sets (<allValues>) stay on the column filter only —
  // hoisting them here would list excluded values as if they were code lists
  if (parsed && parsed.values.length > 0 && !parsed.isAllValuesExcept) {
    // Deduplicate by id
    if (!seen.has(parsed.id)) {
      seen.add(parsed.id);
      out.push(parsed);
    }
  }
}

// --- Column Filters ---

function parseColumnFiltersFromFilterAttrs(filterAttrs: any[]): ColumnFilter[] {
  const filters: ColumnFilter[] = [];

  for (const fa of filterAttrs) {
    if (!fa) continue;
    const columnValues = toArray(fa.columnValue);
    for (const cv of columnValues) {
      const filter = parseColumnFilter(cv);
      if (filter) filters.push(filter);
    }
  }

  return filters;
}

function parseColumnFilter(cvNode: any): ColumnFilter | null {
  if (!cvNode) return null;

  // Extract column(s)
  const columnRaw = cvNode.column;
  let columns: string[] = [];
  if (Array.isArray(columnRaw)) {
    columns = columnRaw.map((c: any) => extractText(c) || '').filter(Boolean);
  } else if (columnRaw) {
    const col = extractText(columnRaw);
    if (col) columns = [col];
  }

  if (columns.length === 0) return null;

  const displayName = extractText(cvNode.displayName) || undefined;
  const inNotIn = extractText(cvNode.inNotIn) || undefined;

  // Range
  let range: DateRange | undefined;
  if (cvNode.rangeValue) {
    range = parseDateRange(cvNode.rangeValue, true);
  }

  // Single value (temporal variable patterns)
  let singleValue: string | undefined;
  if (cvNode.singleValue?.variable) {
    const v = cvNode.singleValue.variable;
    const val = extractText(v.value);
    const unit = extractText(v.unit);
    const relation = extractText(v.relation);
    if (val) {
      singleValue = [val, unit, relation].filter(Boolean).join(' ');
    }
  } else if (cvNode.singleValue) {
    const sv = extractText(cvNode.singleValue);
    if (sv) singleValue = sv;
  }

  // ValueSets within column filter
  let filterValueSets: EmisValueSet[] | undefined;
  if (cvNode.valueSet) {
    const vsNodes = toArray(cvNode.valueSet);
    const parsed: EmisValueSet[] = [];
    for (let i = 0; i < vsNodes.length; i++) {
      const vs = parseValueSet(vsNodes[i], i);
      if (vs && vs.values.length > 0) parsed.push(vs);
    }
    if (parsed.length > 0) filterValueSets = parsed;
  }

  // Runtime parameter — value prompted when the search runs
  let parameter: { name: string; allowGlobal: boolean } | undefined;
  if (cvNode.parameter) {
    const paramName = extractText(cvNode.parameter.name);
    if (paramName) {
      parameter = {
        name: paramName,
        allowGlobal: extractText(cvNode.parameter.allowGlobal) === 'true',
      };
    }
  }

  return {
    id: cvNode['@_id'] || cvNode.id || undefined,
    columns,
    displayName,
    inNotIn,
    range,
    singleValue,
    valueSets: filterValueSets,
    parameter,
  };
}

// --- Date Ranges ---

function parseDateRange(rangeNode: any, resolveBaseline = false): DateRange | undefined {
  if (!rangeNode) return undefined;

  const from = parseRangeBoundary(rangeNode.rangeFrom);
  const to = parseRangeBoundary(rangeNode.rangeTo);
  const relativeTo = extractText(rangeNode['@_relativeTo']) || undefined;

  // EMIS omits the value for a boundary at the search baseline.
  if (resolveBaseline && relativeTo === 'BASELINE') {
    for (const boundary of [from, to]) {
      if (boundary?.operator && boundary.value === undefined) {
        Object.assign(boundary, { value: '0', unit: 'DAY', relation: 'RELATIVE' });
      }
    }
  }

  if (!from && !to) return undefined;
  return { from, to, ...(relativeTo ? { relativeTo } : {}) };
}

function parseRangeBoundary(boundaryNode: any): RangeBoundary | undefined {
  if (!boundaryNode) return undefined;

  const operator = extractText(boundaryNode.operator) || undefined;
  const valueNode = boundaryNode.value;

  if (!valueNode) return operator ? { operator } : undefined;

  // Value can be a nested structure: <value><value>-6</value><unit>MONTH</unit><relation>RELATIVE</relation></value>
  // Or a simple string
  let value: string | undefined;
  let unit: string | undefined;
  let relation: string | undefined;

  if (typeof valueNode === 'object' && valueNode !== null) {
    // Nested structure
    value = extractText(valueNode.value) || undefined;
    unit = extractText(valueNode.unit) || undefined;
    relation = extractText(valueNode.relation) || undefined;
  } else {
    value = String(valueNode);
  }

  if (!value && !operator) return undefined;

  return { operator, value, unit, relation };
}

// --- Restrictions ---

function parseRestrictionsFromCriterion(
  criterionNode: any,
  filterAttrs: any[]
): SearchRestriction[] {
  const restrictions: SearchRestriction[] = [];
  const processedElements = new Set<any>();

  // Direct restriction children of criterion
  const directRestrictions = toArray(criterionNode.restriction);
  for (const r of directRestrictions) {
    if (!processedElements.has(r)) {
      processedElements.add(r);
      const parsed = parseRestriction(r);
      if (parsed) restrictions.push(parsed);
    }
  }

  // Restrictions under filterAttribute
  for (const fa of filterAttrs) {
    if (!fa) continue;

    // Pattern 1: filterAttribute > restriction (sibling to columnValue)
    const faRestrictions = toArray(fa.restriction);
    for (const r of faRestrictions) {
      if (!processedElements.has(r)) {
        processedElements.add(r);
        const parsed = parseRestriction(r);
        if (parsed) restrictions.push(parsed);
      }
    }

    // Pattern 2: filterAttribute > columnValue > restriction
    const columnValues = toArray(fa.columnValue);
    for (const cv of columnValues) {
      const cvRestrictions = toArray(cv?.restriction);
      for (const r of cvRestrictions) {
        if (!processedElements.has(r)) {
          processedElements.add(r);
          const parsed = parseRestriction(r);
          if (parsed) restrictions.push(parsed);
        }
      }
    }
  }

  return restrictions;
}

function parseRestriction(rNode: any): SearchRestriction | null {
  if (!rNode) return null;

  const columnOrder = rNode.columnOrder;
  let recordCount: number | undefined;
  let direction: string | undefined;

  if (columnOrder) {
    const rc = columnOrder.recordCount;
    if (rc != null) {
      recordCount = typeof rc === 'number' ? rc : parseInt(String(rc), 10);
      if (isNaN(recordCount)) recordCount = undefined;
    }

    const cols = columnOrder.columns;
    if (cols) {
      direction = extractText(cols.direction) || undefined;
    }
  }

  // Parse test conditions
  const conditions = parseTestConditions(rNode.testAttribute);

  // Build restriction
  return {
    ...buildRestriction(recordCount, direction, conditions),
    orderColumns: toArray(columnOrder?.columns).map((column) => ({
      column: extractText(column?.column),
      direction: extractText(column?.direction) || undefined,
    })),
    testFilters: toArray(rNode.testAttribute).flatMap((attribute) =>
      toArray(attribute?.columnValue).map(parseColumnFilter).filter((filter): filter is ColumnFilter => filter !== null)),
  };
}

function parseTestConditions(testAttrNode: any): RestrictionCondition[] {
  if (!testAttrNode) return [];

  const conditions: RestrictionCondition[] = [];
  const columnValues = toArray(testAttrNode).flatMap((attribute) => toArray(attribute.columnValue));

  for (const cv of columnValues) {
    const column = extractText(cv?.column) || '';
    const operator = extractText(cv?.inNotIn) || 'IN';

    // ValueSet labels: the cluster description, else the value names. A set
    // without either would drop the test from the restriction text.
    const valueSets: string[] = [];
    const vsNodes = toArray(cv?.valueSet);
    for (const vs of vsNodes) {
      const desc = extractText(vs?.description);
      if (desc) {
        valueSets.push(desc);
        continue;
      }
      const parsed = parseValueSet(vs, 0);
      const names = parsed.values
        .map((v) => v.displayName || (v.isRefset ? `Refset: ${v.code}` : v.code))
        .filter(Boolean);
      if (names.length > 0) {
        const more = names.length > 3 ? ` +${names.length - 3} more` : '';
        valueSets.push(`${parsed.isAllValuesExcept ? 'any except ' : ''}${names.slice(0, 3).join(', ')}${more}`);
      }
    }

    // Range values
    const rangeValues: string[] = [];
    const rangeNodes = toArray(cv?.rangeValue);
    for (const rn of rangeNodes) {
      const desc = formatRangeDescription(rn);
      if (desc) rangeValues.push(desc);
    }

    if (column) {
      conditions.push({
        column,
        operator,
        valueSets: valueSets.length > 0 ? valueSets : undefined,
        rangeValues: rangeValues.length > 0 ? rangeValues : undefined,
      });
    }
  }

  return conditions;
}

const OPERATOR_SYMBOLS: Record<string, string> = {
  GTEQ: '>=', GTE: '>=',
  LTEQ: '<=', LTE: '<=',
  GT: '>', LT: '<', EQ: '=',
};

function formatOp(op: string): string {
  return OPERATOR_SYMBOLS[op?.toUpperCase()] ?? op;
}

function formatRangeBoundaryFriendly(boundaryNode: any): string {
  if (!boundaryNode) return '';
  const op = formatOp(extractText(boundaryNode.operator) || '');
  const valueNode = boundaryNode.value;
  if (!valueNode) return '';

  const val = extractText(valueNode.value ?? valueNode) || '';
  const unit = extractText(valueNode.unit) || '';
  const relation = extractText(valueNode.relation)?.toUpperCase();

  // Absolute dates: show as-is
  if (relation === 'ABSOLUTE' || !unit) {
    return `${op} ${val}`.trim();
  }

  // Relative temporal: -12 MONTH -> "today - 12 months"
  const num = parseInt(val, 10);
  if (!isNaN(num) && unit) {
    const absNum = Math.abs(num);
    const unitLower = unit.toLowerCase();
    const unitLabel = absNum === 1 ? unitLower : `${unitLower}s`;
    if (num < 0) return `${op} today - ${absNum} ${unitLabel}`.trim();
    if (num === 0) return `${op} today`.trim();
    return `${op} today + ${absNum} ${unitLabel}`.trim();
  }

  return `${op} ${val} ${unit}`.trim();
}

function formatRangeDescription(rangeNode: any): string {
  const parts: string[] = [];
  const fromStr = formatRangeBoundaryFriendly(rangeNode?.rangeFrom);
  if (fromStr) parts.push(fromStr);
  const toStr = formatRangeBoundaryFriendly(rangeNode?.rangeTo);
  if (toStr) parts.push(toStr);
  return parts.join(' and ');
}

function buildRestriction(
  recordCount: number | undefined,
  direction: string | undefined,
  conditions: RestrictionCondition[]
): SearchRestriction {
  if (recordCount != null && conditions.length > 0) {
    const base = buildRecordDescription(recordCount, direction);
    const condDesc = buildConditionsDescription(conditions);
    return {
      type: 'conditional_latest',
      description: condDesc ? `${base} where ${condDesc}` : base,
      recordCount,
      direction,
      conditions,
    };
  }

  if (recordCount != null) {
    return {
      type: 'latest_records',
      description: buildRecordDescription(recordCount, direction),
      recordCount,
      direction,
    };
  }

  if (conditions.length > 0) {
    const condDesc = buildConditionsDescription(conditions);
    return {
      type: 'test_condition',
      description: condDesc ? `where ${condDesc}` : 'Additional conditions',
      conditions,
    };
  }

  return { type: 'unknown', description: 'Unknown restriction' };
}

function buildRecordDescription(count: number, direction?: string): string {
  const prefix = direction === 'DESC' ? 'Latest' : 'Earliest';
  return `${prefix} ${count}`;
}

function buildConditionsDescription(conditions: RestrictionCondition[]): string {
  return conditions
    .map((c) => {
      const parts: string[] = [];
      const col = translateColumnName(c.column);

      if (c.valueSets && c.valueSets.length > 0) {
        const vsDesc = c.valueSets.slice(0, 3).join(', ');
        const more = c.valueSets.length > 3 ? ` (+${c.valueSets.length - 3} more)` : '';
        parts.push(`${col} ${formatOp(c.operator)}: ${vsDesc}${more}`);
      }

      if (c.rangeValues && c.rangeValues.length > 0) {
        const rangeText = c.rangeValues.join(' and ');
        parts.push(parts.length > 0 ? `and ${rangeText}` : `${col} ${rangeText}`);
      }

      // No explicit valueSets or ranges — this is an implicit "in above code lists" constraint
      // Suppress it since it's redundant with the criterion's own ValueSets
      if (parts.length === 0) {
        return '';
      }

      return parts.join(' ');
    })
    .filter(Boolean)
    .join(' and ');
}

function translateColumnName(column: string): string {
  const translations: Record<string, string> = {
    READCODE: 'SNOMED code',
    SNOMEDCODE: 'SNOMED code',
    CONCEPT_ID: 'SNOMED concept',
    DRUGCODE: 'medication code',
    CODE_DESCRIPTION: 'code description',
    NUMERIC_VALUE: 'numeric value',
    DATE: 'date',
    AGE: 'age',
    AGE_AT_EVENT: 'age at event',
    CONSULTATION_HEADING: 'consultation heading',
    ORGANISATION_TERM: 'organisation',
    ISSUE_DATE: 'issue date',
  };
  return translations[column] || column.toLowerCase().replace(/_/g, ' ');
}

// --- Linked Criteria ---

function parseLinkedCriteria(criterionNode: any): SearchCriterion[] {
  const linked: SearchCriterion[] = [];
  const linkedNodes = toArray(criterionNode.linkedCriterion);

  for (const ln of linkedNodes) {
    if (!ln) continue;

    // Parse relationship
    const rel = ln.relationship;
    let relationship: LinkedRelationship | undefined;
    if (rel) {
      relationship = {
        parentColumn: extractText(rel.parentColumn) || undefined,
        childColumn: extractText(rel.childColumn) || undefined,
        rangeValue: rel.rangeValue ? parseDateRange(rel.rangeValue) : undefined,
      };
    }

    // Parse nested criterion(s)
    const nestedCritNodes = toArray(ln.criterion);
    for (const nc of nestedCritNodes) {
      const criterion = parseCriterion(nc);
      if (criterion) {
        criterion.relationship = relationship;
        linked.push(criterion);
      }
    }
  }

  return linked;
}

// --- Column Groups (listReport / Dashboard format) ---

export function parseColumnGroups(listReportNode: any): ColumnGroup[] {
  if (!listReportNode) return [];

  const groups: ColumnGroup[] = [];
  const containers = toArray(listReportNode.columnGroups);

  for (const container of containers) {
    const groupNodes = toArray(container?.columnGroup);
    for (const node of groupNodes) {
      const group = parseColumnGroup(node);
      if (group) groups.push(group);
    }
  }

  return groups;
}

function parseColumnGroup(node: any): ColumnGroup | null {
  if (!node) return null;

  const id = extractText(node.id);
  const logicalTableName = extractText(node.logicalTableName) || 'Unknown';
  const displayName = extractText(node.displayName) || 'Unnamed column';

  // Parse list columns from columnar.listColumn[]
  const listColumns: ListColumn[] = [];
  const listColumnNodes = toArray(node.columnar?.listColumn);
  for (const lc of listColumnNodes) {
    const lcId = extractText(lc?.id);
    const lcDisplayName = extractText(lc?.displayName) || '';
    // column can be a single string or array of strings
    const colRaw = lc?.column;
    let columns: string[] = [];
    if (Array.isArray(colRaw)) {
      columns = colRaw.map((c: any) => extractText(c)).filter(Boolean);
    } else if (colRaw) {
      const col = extractText(colRaw);
      if (col) columns = [col];
    }
    if (columns.length > 0) {
      listColumns.push({ id: lcId, columns, displayName: lcDisplayName });
    }
  }

  // Parse criteria (same structure as population criteria)
  const criteria: SearchCriterion[] = [];
  const criteriaContainers = toArray(node.criteria);
  for (const container of criteriaContainers) {
    const criterionNodes = toArray(container?.criterion);
    for (const critNode of criterionNodes) {
      const criterion = parseCriterion(critNode);
      if (criterion) criteria.push(criterion);
    }
  }

  return { id, logicalTableName, displayName, listColumns, criteria };
}

// --- Text extraction helpers ---

function extractText(val: any): string {
  if (val == null) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (typeof val === 'object' && val['#text'] != null) return String(val['#text']).trim();
  return '';
}
