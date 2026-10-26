import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RuleDisplay from '../components/rule-display';
import { parseEmisXml } from './xml-parser';
import {
  buildImplementationGuideMarkdown,
  buildReportLogicSummary,
  buildRulesMarkdown,
  getCriterionDisplayData,
  SAME_COLUMN_CONJUNCTION_CAVEAT,
} from './agent-report-utils';
import { formatColumnFilterRange, formatRelationship, formatValueSetCondition, formatRestriction, humanizeRawTemporal } from './rule-format-utils';

const document = parseEmisXml(readFileSync(path.join(__dirname, 'fixtures/filter-fidelity.xml'), 'utf8'));

async function fixture(criterionPrefix: string) {
  const { reports } = await document;
  const report = reports.find((candidate) => candidate.criteriaGroups?.[0].criteria[0].id.startsWith(criterionPrefix));
  assert.ok(report, `Missing fixture ${criterionPrefix}`);
  const criterion = report.criteriaGroups![0].criteria[0];
  const interpretation = buildReportLogicSummary(report, reports).agentInterpretation;
  return {
    report, reports, criterion, interpretation,
    detail: interpretation.decisionFlow[0].criteriaDetails[0],
    guide: buildImplementationGuideMarkdown(report, reports),
    display: getCriterionDisplayData(criterion),
  };
}

test('AF_61 keeps the two drug filters conjunctive and enums separate', async () => {
  const { report, criterion, interpretation, detail, guide, display } = await fixture('b799351b');
  assert.equal(display.filters.length, 4);
  assert.deepEqual(display.filters.map((filter) => `${filter.label} ${filter.value}`), [
    'Drug code in Oral Anticoagulants',
    'Course status: Current',
    'Prescription type: Automatic, Repeat, Repeat Dispensed',
    'Drug code in Digoxin, Flecainide Acetate, Propafenone Hydrochloride',
  ]);
  assert.match(detail.rendered, /Drug code in Oral Anticoagulants AND Course status: Current AND Prescription type: Automatic, Repeat, Repeat Dispensed AND Drug code in Digoxin/);
  const filterLines = guide.split('\n').filter((line) => /- (Where|AND) /.test(line));
  assert.equal(filterLines.length, 4);
  assert.match(filterLines[0], /Where drug code in .*Oral Anticoagulants/);
  assert.match(filterLines[3], /AND drug code in .*Digoxin, Flecainide Acetate, Propafenone Hydrochloride/);
  assert.ok(filterLines.every((line) => !line.includes(' OR ')));
  assert.ok(guide.includes(SAME_COLUMN_CONJUNCTION_CAVEAT));
  const logicMarkdown = buildRulesMarkdown(report, []);
  assert.ok(logicMarkdown.includes(SAME_COLUMN_CONJUNCTION_CAVEAT));
  assert.match(logicMarkdown, /A single record must match every drug code filter \(code lists: .*_vs1, .*_vs4\)/);
  assert.deepEqual(interpretation.sameColumnConjunctions, [{
    criterionId: criterion.id,
    column: 'DRUGCODE',
    filterIds: ['d2065217-60ed-4bb6-aae1-74949a5bca39', criterion.columnFilters[3].id],
    valueSetNames: detail.filters.filter((filter) => filter.columns[0] === 'DRUGCODE').flatMap((filter) => filter.valueSets.map((set) => set.friendlyName)),
  }]);
  assert.equal(criterion.valueSets.length, 4, 'The flat list still includes enums for existing consumers');
  assert.equal(criterion.valueSetFilters?.length, 4);
  assert.ok(criterion.valueSetFilters?.every((filter) => filter.source === 'filter' && filter.inNotIn === 'IN'));
  assert.ok(detail.valueSets.every((set) => set.codeSystem !== 'Internal'));
});

function renderRule(report: Awaited<ReturnType<typeof fixture>>['report']) {
  return renderToStaticMarkup(createElement(RuleDisplay, {
    report, allReports: [report], expandedData: null, isExpanding: false,
    totalValueSets: report.valueSets.length, onExpandClick() {}, onCancel() {},
  }));
}

test('the COPD UI renders nested filters, AND, NOT, restrictions and linked criteria', async () => {
  const { report, criterion } = await fixture('736eb32c');
  assert.equal(criterion.baseCriteriaGroups?.length, 2);
  assert.equal(criterion.baseCriteriaGroups[0].criteria[1].negation, true);
  const html = renderRule(report);
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.ok(text.includes('copd_reg_vs2'), 'The COPD resolved set must remain visible');
  assert.equal((text.match(/ALL \(AND\) of the following/g) ?? []).length, 2);
  assert.match(text, /Clinical Codes EVENTS NOT Where Code in COPDRES_COD/);
  assert.match(text, /Keep the earliest 1 by date/);
  assert.match(text, /Linked criteria:.*DATE strictly after parent record/);
  assert.ok(text.includes('on or before the search date'));

  const withOr = structuredClone(report);
  withOr.criteriaGroups![0].criteria[0].baseCriteriaGroups![0].memberOperator = 'OR';
  assert.ok(renderRule(withOr).includes('ANY (OR)'));
});

test('restriction singleValue dates use the same words as filter lines and API phrases', async () => {
  const { report, criterion, detail, guide, display } = await fixture('267c4f47');
  assert.match(display.restrictions[0].value, /Keep the latest 100 by date; passes if at least one kept record meets the test: date in this fiscal year/);
  assert.ok(guide.includes('date in this fiscal year'));
  assert.ok(detail.rendered.includes('date in this fiscal year'));
  assert.ok(!detail.rendered.includes('then Filters'));
  assert.ok(!guide.includes('FISCALYEAR RELATIVE'));
  assert.ok(renderRule(report).includes('date in this fiscal year'));
  const filter = criterion.restrictions[0].testFilters![0];
  const asFilter = { ...criterion, columnFilters: [filter], restrictions: [] };
  assert.equal(getCriterionDisplayData(asFilter).filters[0].value, 'in this fiscal year');

  const repeated = structuredClone(report);
  repeated.criteriaGroups![0].criteria[0].restrictions.push(structuredClone(criterion.restrictions[0]));
  for (const output of [buildImplementationGuideMarkdown(repeated, [repeated]), buildRulesMarkdown(repeated, [repeated]), renderRule(repeated)]) {
    assert.ok(!output.includes('Filters select candidate records'), 'Each restriction line states its own order');
  }
});

test('filter summaries omit stray IN and use explicit named-period boundaries', async () => {
  const { detail } = await fixture('d8e067f0');
  assert.ok(detail.filters.every((filter) => !/\bIN on/.test(filter.rendered)));
  assert.equal(formatColumnFilterRange({ from: { operator: 'GTEQ', value: 'This', unit: 'FISCALYEAR', relation: 'RELATIVE' } }, 'DATE'), 'on or after the start of this fiscal year');
  assert.equal(formatRestriction({ type: 'latest', description: '', recordCount: 2 }), 'Keep the first 2');
  assert.equal(humanizeRawTemporal('3 MONTH ABSOLUTE', 'DOB'), 'in March');
});

test('HF PG2 keeps both ISSUE_DATE bounds with strict and inclusive wording', async () => {
  const { criterion, detail, guide, interpretation } = await fixture('d8e067f0');
  const window = 'strictly after 6 months before the search date AND on or before the search date';
  assert.ok(detail.rendered.includes(window));
  assert.ok(guide.includes(window));
  assert.match(guide, /issue date > today - 6 months AND issue date <= today/);
  assert.deepEqual(criterion.columnFilters[2].range, {
    to: { operator: 'LTEQ', value: '0', unit: 'DAY', relation: 'RELATIVE' },
    from: undefined,
    relativeTo: 'BASELINE',
  });
  assert.deepEqual(interpretation.sameColumnConjunctions, []);
});

test('ICS_HF_21 keeps ACE_COD and AII_COD as OR inside one drug filter', async () => {
  const { criterion, guide, detail, interpretation } = await fixture('fbffb377');
  assert.equal(criterion.valueSetFilters?.filter((filter) => filter.source === 'filter').length, 1);
  assert.match(detail.rendered, /Drug code in \(ACE_COD OR AII_COD\) AND Issue date/);
  assert.match(guide, /Where drug code in \(.*cluster ACE_COD\) OR .*cluster AII_COD\)\)/);
  assert.ok(!guide.includes(SAME_COLUMN_CONJUNCTION_CAVEAT));
  assert.deepEqual(interpretation.sameColumnConjunctions, []);
});

test('DM_64 tests NOTIN after ranking its latest 999 records', async () => {
  const { criterion, display, detail, guide } = await fixture('7f2ced24');
  assert.equal(criterion.restrictions[0].recordCount, 999);
  assert.equal(display.filters.length, 1);
  assert.ok(!detail.rendered.split('then keep')[0].includes('not in'));
  assert.match(detail.rendered, /keep the latest 999 by date; passes if at least one kept record meets the test: code not in Irish/);
  assert.match(guide, /Keep the latest 999 by date; passes if at least one kept record meets the test: code not in/);
  assert.equal(display.testValueSets.length, 1);
  assert.deepEqual(criterion.valueSetFilters?.map((filter) => [filter.source, filter.column, filter.inNotIn]), [
    ['filter', 'READCODE', 'IN'], ['restriction-test', 'READCODE', 'NOTIN'],
  ]);
  assert.equal(detail.valueSets.length, 1);
  assert.equal(detail.restrictionValueSets[0].codeCount, 17);
  assert.deepEqual(detail.restrictionValueSets[0].testOperators, ['NOTIN']);
  assert.match(guide, /Restriction test sets.*\[NOTIN\]/);
  assert.equal(criterion.valueSets.length, 2, 'The flat list still retains restriction test sets');
});

test('Latest 1 NOTIN checks the kept record, without excluding candidates first', async () => {
  const { criterion, detail, guide, display } = await fixture('eccfbddb');
  assert.equal(criterion.restrictions[0].recordCount, 1);
  assert.equal(display.filters.length, 1);
  assert.match(detail.rendered, /Code in \(DMRES_COD OR DM_COD\) then keep the latest 1 by date and test the kept record: code not in Type 1/);
  assert.match(guide, /Keep the latest 1 by date, then test the kept record: code not in/);
  assert.equal(detail.valueSets.length, 2);
  assert.equal(detail.restrictionValueSets.length, 1);
  assert.ok(!guide.split('Keep the latest 1 by date')[0].includes('not in'), 'The NOTIN test applies after ranking');
  assert.match(guide, /\[NOTIN\]/);
  assert.ok(!guide.includes('[IN]'));
});

test('date wording distinguishes strict and inclusive bounds around the search date', () => {
  for (const [operator, expected] of [
    ['GT', 'strictly after'], ['GTEQ', 'on or after'], ['LT', 'strictly before'], ['LTEQ', 'on or before'],
  ]) {
    assert.equal(formatColumnFilterRange({ from: { operator, value: '-6', unit: 'MONTH', relation: 'RELATIVE' } }, 'ISSUE_DATE'), `${expected} 6 months before the search date`);
    assert.equal(formatColumnFilterRange({ to: { operator, value: '0', unit: 'DAY', relation: 'RELATIVE' } }, 'DATE'), `${expected} the search date`);
    assert.equal(formatColumnFilterRange({ from: { operator, value: '2025-01-01', relation: 'ABSOLUTE' } }, 'DATE'), `${expected} 2025-01-01`);
  }
  assert.equal(formatColumnFilterRange({ from: { operator: 'GTEQ', value: '35' } }, 'NUMERIC_VALUE'), '>= 35');
});

test('CYPAST_HR_DTR links a record within the 3 months before the desktop review', async () => {
  const { report, reports, detail, guide } = await fixture('6411d554');
  const window = "DATE on or after 3 months before parent record's DATE and strictly before 1 day before parent record's DATE";
  const linked = detail.linkedCriteria[0].relationship!;
  assert.equal(linked.rendered, window);
  assert.equal(linked.range?.from?.rendered, "on or after 3 months before parent record's DATE");
  assert.equal(linked.range?.to?.rendered, "strictly before 1 day before parent record's DATE");
  assert.match(guide, /Linked record A\.1\*\* — join: its date on or after 3 months before the date of record A and strictly before 1 day before the date of record A, `A\.1 date >= A date - 3 months AND A\.1 date < A date - 1 day`/);
  assert.match(buildRulesMarkdown(report, reports), /From: on or after 3 months before parent record's DATE/);
  for (const output of [guide, buildRulesMarkdown(report, reports), renderRule(report), JSON.stringify(detail)]) {
    assert.ok(!/at least 3 months before|under 1 day before|before the search date AND strictly before 1 day/.test(output));
  }
  assert.ok(renderRule(report).includes(window.replace(/'/g, '&#x27;')));
});

test('linked windows read relative to the parent record for every operator and sign', () => {
  const relationship = (operator: string, value: string) => formatRelationship({
    parentColumn: 'DATE', childColumn: 'DATE', rangeValue: { from: { operator, value, unit: 'DAY' } },
  });
  for (const [operator, words] of [
    ['GT', 'strictly after'], ['GTEQ', 'on or after'], ['LT', 'strictly before'], ['LTEQ', 'on or before'],
  ]) {
    assert.equal(relationship(operator, '-93'), `DATE ${words} 93 days before parent record's DATE`);
    assert.equal(relationship(operator, '186'), `DATE ${words} 186 days after parent record's DATE`);
    assert.equal(relationship(operator, '0'), `DATE ${words} parent record's DATE`);
  }
  assert.equal(formatRelationship({ parentColumn: 'DATE', childColumn: 'DATE' }), 'Linked on DATE');
});

test('OR within a filter preserves complements and applies NOTIN to the union', () => {
  const sets = [{ name: 'A' }, { name: 'B', isAllValuesExcept: true }];
  assert.equal(formatValueSetCondition(sets, false, (set) => set.name), 'in (A OR all values except B)');
  assert.equal(formatValueSetCondition(sets, true, (set) => set.name), 'not in (A OR all values except B)');
  assert.equal(formatValueSetCondition([sets[1]], true, (set) => set.name), 'in B');
});

test('an implicit code-list test does not invent another restriction condition', () => {
  assert.equal(formatRestriction({
    type: 'conditional_latest', description: 'Latest 1', recordCount: 1, direction: 'DESC',
    orderColumns: [{ column: 'DATE', direction: 'DESC' }],
    testFilters: [{ columns: ['READCODE'], inNotIn: 'IN' }],
    conditions: [{ column: 'READCODE', operator: 'IN' }],
  }), 'Keep the latest 1 by date');
});

test('agent conjunction warnings include linked and nested criteria', async () => {
  const { report, criterion } = await fixture('b799351b');
  const wrapper = structuredClone(report);
  wrapper.criteriaGroups![0].criteria = [{
    id: 'wrapper', table: 'EVENTS', displayName: 'Wrapper', negation: false,
    valueSets: criterion.valueSets, columnFilters: [], restrictions: [],
    linkedCriteria: [{ ...criterion, id: 'linked' }],
    baseCriteriaGroups: [{ memberOperator: 'OR', criteria: [{ ...criterion, id: 'nested' }] }],
  }];
  const summary = buildReportLogicSummary(wrapper, [wrapper]);
  assert.deepEqual(summary.agentInterpretation.sameColumnConjunctions.map((warning) => warning.criterionId), ['linked', 'nested']);
  assert.equal(summary.agentInterpretation.decisionFlow[0].criteriaDetails[0].valueSets.length, 0);
  assert.ok(!summary.agentInterpretation.plainEnglishSummary.includes('with Oral Anticoagulants OR'));
});

test('the rule UI keeps drug filters separate and uses a neutral restriction-set label', async () => {
  const render = async (prefix: string) => {
    const { report, reports } = await fixture(prefix);
    return renderToStaticMarkup(createElement(RuleDisplay, {
      report, allReports: reports, expandedData: null, isExpanding: false,
      totalValueSets: report.valueSets.length, onExpandClick() {}, onCancel() {},
    }));
  };
  const af = await render('b799351b');
  assert.equal((af.match(/Drug code/g) ?? []).length, 2);
  assert.ok(af.includes('Oral Anticoagulants'));
  assert.ok(af.includes('Digoxin, Flecainide Acetate, Propafenone Hydrochloride'));
  assert.ok(af.includes('Course status:'));
  assert.ok(af.includes('Prescription type:'));
  assert.ok(af.includes('A single record must match every drug code filter'));
  const notIn = await render('eccfbddb');
  assert.ok(notIn.includes('then test the kept record: code not in'));
  assert.ok(notIn.includes('Restriction test sets, applied after record selection'));
  assert.ok(!notIn.includes('code must be in'));
});
