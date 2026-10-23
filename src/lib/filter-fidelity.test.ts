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
  getCriterionDisplayData,
  SAME_COLUMN_CONJUNCTION_CAVEAT,
} from './agent-report-utils';
import { formatColumnFilterRange, formatValueSetCondition, formatRestriction } from './rule-format-utils';

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
  const { criterion, interpretation, detail, guide, display } = await fixture('b799351b');
  assert.equal(display.filters.length, 4);
  assert.deepEqual(display.filters.map((filter) => `${filter.label} ${filter.value}`), [
    'Drug code in Oral Anticoagulants',
    'Status: Current',
    'Prescription type: Automatic, Repeat, Repeat Dispensed',
    'Drug code in Digoxin, Flecainide Acetate, Propafenone Hydrochloride',
  ]);
  assert.match(detail.rendered, /Drug code in Oral Anticoagulants AND Status: Current AND Prescription type: Automatic, Repeat, Repeat Dispensed AND Drug code in Digoxin/);
  const filterLines = guide.split('\n').filter((line) => /- (Where|AND) /.test(line));
  assert.equal(filterLines.length, 4);
  assert.match(filterLines[0], /Where drug code in .*Oral Anticoagulants/);
  assert.match(filterLines[3], /AND drug code in .*Digoxin, Flecainide Acetate, Propafenone Hydrochloride/);
  assert.ok(filterLines.every((line) => !line.includes(' OR ')));
  assert.ok(guide.includes(SAME_COLUMN_CONJUNCTION_CAVEAT));
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
  assert.ok(!detail.rendered.split('then Filters')[0].includes('not in'));
  assert.match(detail.rendered, /keep the latest 999 by date; then the criterion passes if at least one of the kept records meets the test: code not in Irish/);
  assert.match(guide, /Filters select candidate records; keep the latest 999 by date; then the criterion passes if at least one of the kept records meets the test: code not in/);
  assert.equal(display.testValueSets.length, 1);
  assert.deepEqual(criterion.valueSetFilters?.map((filter) => [filter.source, filter.column, filter.inNotIn]), [
    ['filter', 'READCODE', 'IN'], ['restriction-test', 'READCODE', 'NOTIN'],
  ]);
  assert.equal(detail.valueSets.length, 1);
  assert.equal(detail.restrictionValueSets[0].codeCount, 17);
  assert.equal(criterion.valueSets.length, 2, 'The flat list still retains restriction test sets');
});

test('Latest 1 NOTIN checks the kept record, without excluding candidates first', async () => {
  const { criterion, detail, guide, display } = await fixture('eccfbddb');
  assert.equal(criterion.restrictions[0].recordCount, 1);
  assert.equal(display.filters.length, 1);
  assert.match(detail.rendered, /Code in \(DMRES_COD OR DM_COD\) then Filters select candidate records; keep the latest 1 by date; then apply the test to the kept record: code not in Type 1/);
  assert.match(guide, /keep the latest 1 by date; then apply the test to the kept record: code not in/);
  assert.equal(detail.valueSets.length, 2);
  assert.equal(detail.restrictionValueSets.length, 1);
  assert.ok(!guide.split('Filters select candidate records')[0].includes('not in'));
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
  }), 'Filters select candidate records; keep the latest 1 by date');
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
  assert.ok(af.includes('Status:'));
  assert.ok(af.includes('Prescription type:'));
  assert.ok(af.includes('A single record must match every one of these filters.'));
  const notIn = await render('eccfbddb');
  assert.ok(notIn.includes('then apply the test to the kept record: code not in'));
  assert.ok(notIn.includes('Restriction test sets, applied after record selection'));
  assert.ok(!notIn.includes('code must be in'));
});
