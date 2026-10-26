/**
 * Human-readable formatting utilities for EMIS rule structures.
 */

import type { RangeBoundary, DateRange, SearchRestriction, LinkedRelationship, EmisValueSet } from './types';

const OPERATOR_MAP: Record<string, string> = {
  GTEQ: '>=',
  LTEQ: '<=',
  GT: '>',
  LT: '<',
  EQ: '=',
  GTE: '>=',
  LTE: '<=',
};

const FRIENDLY_OP: Record<string, string> = {
  GTEQ: 'at least',
  LTEQ: 'at most',
  GT: 'more than',
  LT: 'under',
  EQ: 'exactly',
  GTE: 'at least',
  LTE: 'at most',
};

/** Date operator words, strict vs inclusive spelled out. */
const DATE_OP: Record<string, string> = {
  GT: 'strictly after', GTE: 'on or after', GTEQ: 'on or after',
  LT: 'strictly before', LTE: 'on or before', LTEQ: 'on or before', EQ: 'on',
};

const UNIT_LABELS: Record<string, string> = {
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  QUARTER: 'quarter',
  YEAR: 'year',
  FISCALYEAR: 'fiscal year',
  DATE: '',
};

function pluralise(unit: string, count: number): string {
  const label = UNIT_LABELS[unit?.toUpperCase()] ?? unit?.toLowerCase() ?? '';
  if (!label) return '';
  return Math.abs(count) === 1 ? label : `${label}s`;
}

export function formatOperator(op: string): string {
  return OPERATOR_MAP[op?.toUpperCase()] ?? op ?? '';
}

function friendlyOp(op: string): string {
  return FRIENDLY_OP[op?.toUpperCase()] ?? formatOperator(op);
}

export function formatRangeBoundary(b: RangeBoundary | undefined): string {
  if (!b) return '';

  const op = formatOperator(b.operator || '');
  const val = b.value ?? '';
  const unit = b.unit?.toUpperCase() ?? '';
  const relation = b.relation?.toUpperCase();

  // Operator-only boundary with no value — skip
  if (!val && op) return '';

  if (relation === 'ABSOLUTE') {
    return `${op} ${val}`.trim();
  }

  // Named temporal variables: "Last", "This", "Next"
  if (['Last', 'This', 'Next'].includes(val)) {
    const unitLabel = UNIT_LABELS[unit] ?? unit.toLowerCase();
    return `${op} ${val} ${unitLabel}`.trim();
  }

  // Numeric relative: -6 MONTH -> "6 months ago"
  const num = parseInt(val, 10);
  if (!isNaN(num)) {
    const absNum = Math.abs(num);
    const unitLabel = pluralise(unit, absNum);
    if (num < 0) return `${op} ${absNum} ${unitLabel} ago`.trim();
    if (num === 0) return `${op} now`.trim();
    return `${op} ${absNum} ${unitLabel} ahead`.trim();
  }

  return `${op} ${val} ${unit}`.trim();
}

/**
 * Format a range boundary with human-friendly language for column filters.
 * Uses column context to produce natural descriptions.
 */
function friendlyBoundary(b: RangeBoundary | undefined, column?: string): string {
  if (!b) return '';
  const val = b.value ?? '';
  const unit = b.unit?.toUpperCase() ?? '';
  const relation = b.relation?.toUpperCase();
  const op = b.operator?.toUpperCase() ?? '';
  const col = column?.toUpperCase() ?? '';
  const isNumeric = ['AGE', 'AGE_AT_EVENT', 'NUMERIC_VALUE', 'VALUE'].includes(col);
  const operatorWords = isNumeric ? friendlyOp(op) : (DATE_OP[op] || formatOperator(op));

  // Operator-only boundary with no value — unbounded constraint (e.g. "date must exist")
  if (!val && op) return '';

  if (relation === 'ABSOLUTE') {
    return `${operatorWords} ${val}`.trim();
  }

  // Named temporal: "Last", "This", "Next"
  if (['Last', 'This', 'Next'].includes(val)) {
    const unitLabel = UNIT_LABELS[unit] ?? unit.toLowerCase();
    const period = `${val.toLowerCase()} ${unitLabel}`;
    return `${operatorWords} ${['GTE', 'GTEQ'].includes(op) ? `the start of ${period}` : period}`.trim();
  }

  const num = parseInt(val, 10);
  if (!isNaN(num)) {
    const absNum = Math.abs(num);
    const unitLabel = pluralise(unit, absNum);
    const isAge = col === 'AGE' || col === 'AGE_AT_EVENT';

    if (isAge) {
      return `${friendlyOp(op)} ${absNum} ${unitLabel} old`;
    }

    if (isNumeric || !unit) {
      // Numeric column or no unit — plain threshold, not temporal
      return `${formatOperator(op)} ${val}`.trim();
    }

    const point = num === 0 ? 'the search date'
      : `${absNum} ${unitLabel} ${num < 0 ? 'before' : 'after'} the search date`;
    return `${operatorWords} ${point}`;
  }

  return `${friendlyOp(op)} ${val} ${unit}`.trim();
}

export function formatDateRange(r: DateRange | undefined): string {
  if (!r) return '';
  const fromStr = formatRangeBoundary(r.from);
  const toStr = formatRangeBoundary(r.to);

  if (fromStr && toStr) return `${fromStr} to ${toStr}`;
  return fromStr || toStr || '';
}

/**
 * Format a column filter range as a friendly description.
 * Accepts column name for context-sensitive formatting.
 */
export function formatColumnFilterRange(r: DateRange | undefined, column?: string): string {
  if (!r) return '';
  const fromStr = friendlyBoundary(r.from, column);
  const toStr = friendlyBoundary(r.to, column);

  if (fromStr && toStr) return `${fromStr} AND ${toStr}`;
  return fromStr || toStr || '';
}

/** Named periods arrive as flattened XML variable tokens. */
export function humanizeRawTemporal(value: string, column?: string): string {
  const month = value.match(/^(\d+) MONTH ABSOLUTE$/i);
  if (column === 'DOB' && month && Number(month[1]) >= 1 && Number(month[1]) <= 12) {
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return `in ${months[Number(month[1]) - 1]}`;
  }
  const match = value.match(/^(Last|This|Next)\s+([A-Z]+)(?:\s+RELATIVE)?$/i);
  if (!match) return value;
  const unit = UNIT_LABELS[match[2].toUpperCase()] || match[2].toLowerCase();
  return `in ${match[1].toLowerCase()} ${unit}`;
}


export function formatValueSetCondition<T extends { isAllValuesExcept?: boolean }>(
  sets: T[],
  notIn: boolean,
  describe: (set: T) => string,
): string {
  if (sets.length === 1) {
    return `${notIn !== Boolean(sets[0].isAllValuesExcept) ? 'not in' : 'in'} ${describe(sets[0])}`;
  }
  const union = sets.map((set) => `${set.isAllValuesExcept ? 'all values except ' : ''}${describe(set)}`).join(' OR ');
  return `${notIn ? 'not in' : 'in'} (${union})`;
}

function restrictionSetLabel(set: EmisValueSet): string {
  if (set.description) return set.description;
  const names = set.values.map((value) => value.displayName || value.code);
  return names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3} more` : '');
}

export function formatRestriction(r: SearchRestriction): string {
  const labels: Record<string, string> = {
    READCODE: 'code', DRUGCODE: 'drug code', NUMERIC_VALUE: 'numeric value',
    DATE: 'date', ISSUE_DATE: 'issue date',
  };
  const label = (column: string) => labels[column] || column.toLowerCase().replace(/_/g, ' ');
  const tests = (r.testFilters ?? []).map((filter) => {
    const name = filter.columns.map(label).join(', ');
    if (filter.valueSets?.length) {
      return `${name} ${formatValueSetCondition(filter.valueSets, filter.inNotIn === 'NOTIN', restrictionSetLabel)}`;
    }
    const value = formatColumnFilterRange(filter.range, filter.columns[0]) || humanizeRawTemporal(filter.singleValue || '', filter.columns[0]);
    return value ? `${name} ${filter.inNotIn === 'NOTIN' ? 'not ' : ''}${value}` : '';
  }).filter(Boolean);
  if (tests.length === 0 && r.conditions?.length) {
    for (const condition of r.conditions) {
      const name = label(condition.column);
      if (condition.valueSets?.length) {
        tests.push(`${name} ${condition.operator === 'NOTIN' ? 'not in' : 'in'} (${condition.valueSets.join(' OR ')})`);
      }
      if (condition.rangeValues?.length) {
        tests.push(`${name} ${condition.operator === 'NOTIN' ? 'not ' : ''}${condition.rangeValues.join(' AND ')}`);
      }
    }
  }
  if (r.recordCount == null) {
    return tests.length ? `Require ${tests.join(' AND ')}` : r.description || 'Unknown restriction';
  }
  const direction = r.direction === 'DESC' ? 'latest' : r.direction === 'ASC' ? 'earliest' : 'first';
  const order = (r.orderColumns ?? []).map((column) =>
    `${label(column.column)}${column.direction && column.direction !== r.direction ? ` ${column.direction}` : ''}`).join(', ');
  const rank = `Keep the ${direction} ${r.recordCount}${order ? ` by ${order}` : ''}`;
  if (!tests.length) return rank;
  const test = tests.join(' AND ');
  return r.recordCount === 1
    ? `${rank}, then test the kept record: ${test}`
    : `${rank}; passes if at least one kept record meets the test: ${test}`;
}

/**
 * One linked-window boundary, anchored to the parent record:
 * GTEQ -3 MONTH -> "on or after 3 months before parent record's DATE"
 * (child date >= parent date - 3 months, i.e. no more than 3 months before it).
 */
export function formatRelationshipBoundary(b: RangeBoundary | undefined, parentColumn: string): string {
  if (!b) return '';
  const val = b.value ?? '';
  const op = b.operator?.toUpperCase() ?? '';
  if (!val && op) return '';

  const num = parseInt(val, 10);
  const words = DATE_OP[op];
  if (!words || isNaN(num) || b.relation?.toUpperCase() === 'ABSOLUTE') return formatRangeBoundary(b);

  const anchor = `parent record's ${parentColumn}`;
  if (num === 0) return `${words} ${anchor}`;
  if (!b.unit) return formatRangeBoundary(b);
  const absNum = Math.abs(num);
  return `${words} ${absNum} ${pluralise(b.unit, absNum)} ${num < 0 ? 'before' : 'after'} ${anchor}`;
}

/** Both boundaries of a linked window, each with its own anchor. */
export function formatRelationshipRange(r: DateRange | undefined, parentColumn: string): string {
  if (!r) return '';
  return [r.from, r.to].map((b) => formatRelationshipBoundary(b, parentColumn)).filter(Boolean).join(' and ');
}

export function formatRelationship(r: LinkedRelationship | undefined): string {
  if (!r) return 'Linked criterion';

  const parent = r.parentColumn ?? '?';
  const child = r.childColumn ?? '?';

  const rangeDesc = formatRelationshipRange(r.rangeValue, parent);
  if (rangeDesc) return `${child} ${rangeDesc}`;
  return parent === child ? `Linked on ${parent}` : `${parent} linked to ${child}`;
}
