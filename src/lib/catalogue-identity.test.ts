import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preserveCatalogueIdentities } from './catalogue-identity';
import { NormalizedTables } from './batch-assembly';

const make = (extraFirst: boolean): NormalizedTables => ({
  reports: [{ report_id: 'new-report-hash', report_xml_id: 'stable-xml-id', parent_report_id: '' }],
  valuesets: (extraFirst ? ['extra', 'existing'] : ['existing', 'extra']).map((name, index) => ({
    valueset_id: name, report_id: 'new-report-hash', valueset_index: index,
    valueset_hash: name === 'existing' ? 'old-hash' : 'new-hash', valueset_friendly_name: `synthetic_vs${index + 1}`,
  })),
  originalCodes: ['existing', 'extra'].map(valueset_id => ({ original_code_id: `${valueset_id}-oc0`, valueset_id, original_code: valueset_id, include_children: true })),
  exceptions: [{ exception_id: 'existing-exc0', valueset_id: 'existing', original_excluded_code: '100001' }],
  expandedConcepts: [{ concept_id: 'existing-c0', valueset_id: 'existing', snomed_code: '200001' }], failedCodes: [],
});
const loaded = {
  reports: [{ report_id: 'loaded-report', report_xml_id: 'stable-xml-id' }],
  valuesets: [{ valueset_id: 'loaded-id', report_id: 'loaded-report', valueset_hash: 'old-hash', valueset_index: 3, valueset_friendly_name: 'loaded_vs4' }],
  originalCodes: [{ valueset_id: 'loaded-id', original_code: 'existing', include_children: true }],
  exceptions: [{ valueset_id: 'loaded-id', original_excluded_code: '100001' }],
};
test('loaded report/value-set IDs, names and all child keys survive new instances and parser order', () => {
  const a = make(true), b = make(false);
  for (const tables of [a, b]) {
    preserveCatalogueIdentities(tables, loaded);
    assert.equal(tables.reports[0].report_id, 'loaded-report');
    assert.deepEqual(tables.valuesets.find(v => v.valueset_id === 'loaded-id'), loaded.valuesets[0]);
    assert.equal(tables.originalCodes[0].original_code_id, 'loaded-id-oc0');
    assert.equal(tables.exceptions[0].exception_id, 'loaded-id-exc0');
    assert.equal(tables.expandedConcepts[0].concept_id, 'loaded-id-c0');
    assert.equal(tables.valuesets.find(v => v.valueset_id !== 'loaded-id')!.valueset_index, 4);
  }
  assert.deepEqual(a.valuesets.map(v => v.valueset_id).sort(), b.valuesets.map(v => v.valueset_id).sort());
});
test('identical code hashes with different child flags retain their own identities', () => {
  const tables = make(false);
  tables.valuesets[1].valueset_hash = 'old-hash';
  tables.originalCodes[1] = { ...tables.originalCodes[0], valueset_id: 'extra', original_code_id: 'extra-oc0', include_children: false };
  tables.exceptions.push({ ...tables.exceptions[0], valueset_id: 'extra', exception_id: 'extra-exc0' });
  preserveCatalogueIdentities(tables, loaded);
  assert.equal(tables.valuesets[0].valueset_id, 'loaded-id');
  assert.notEqual(tables.valuesets[1].valueset_id, 'loaded-id');
});
test('ambiguous loaded identities fail before output', () => {
  const tables = make(false);
  tables.valuesets[1].valueset_hash = 'old-hash';
  tables.originalCodes[1] = { ...tables.originalCodes[0], valueset_id: 'extra' };
  tables.exceptions.push({ ...tables.exceptions[0], valueset_id: 'extra' });
  assert.throws(() => preserveCatalogueIdentities(tables, loaded), /Ambiguous loaded/);
});
