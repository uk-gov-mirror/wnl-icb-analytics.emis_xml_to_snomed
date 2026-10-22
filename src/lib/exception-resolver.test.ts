import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExceptions, exceptionError } from './exception-resolver';
import { expandValueSetClientSide } from './client-valueset-expander';
import { generateExpansionKey } from './valueset-utils';
import { EmisValueSet, SnomedConcept } from './types';

const concept = (code: string, display: string): SnomedConcept => ({ code, display, system: 'http://snomed.info/sct', source: 'terminology_server' });
const exception = { code: '170041000033114', displayName: 'Budesonide Ointment 0.025 %' };
const translations = { [exception.code]: { code: '108622005', display: 'Budesonide-containing product' } };

test('a preparation exception resolves to its exact VMP family rather than its ingredient grouper', async () => {
  const result = await resolveExceptions([exception], translations, {}, async () => [
    concept('746901000001108', 'Budesonide 0.025% ointment'),
    concept('10073911000001106', 'Easyhaler Budesonide 200micrograms/dose dry powder inhaler'),
  ]);
  assert.equal(result[0].code, '746901000001108');
  assert.equal(exceptionError(result), undefined);
});

test('missing, ambiguous and different-strength preparations require reconciliation', async () => {
  for (const candidates of [[], [concept('100001', 'Budesonide 0.05% ointment')],
    [concept('100001', 'Budesonide 0.025% ointment'), concept('100002', 'Budesonide 0.025% ointment')]]) {
    const result = await resolveExceptions([exception], translations, {}, async () => candidates);
    assert.equal(result[0].code, null);
    assert.match(exceptionError(result)!, /Quarantined/);
  }
});

test('combination preparations cannot swap the strengths of their ingredients', async () => {
  const result = await resolveExceptions([{ code: '100000', displayName: 'DrugA 10mg / DrugB 20mg tablets' }], {}, {},
    async () => [concept('100001', 'DrugA 20mg / DrugB 10mg tablets')]);
  assert.equal(result[0].code, null);
});

test('unmapped clinical exceptions are visible and terminology failures propagate', async () => {
  const result = await resolveExceptions([{ code: '100001', displayName: 'Synthetic diagnosis' }], {}, {}, async () => []);
  assert.match(result[0].error!, /no accepted ConceptMap translation/);
  await assert.rejects(resolveExceptions([exception], translations, {}, async () => { throw Error('unavailable'); }), /unavailable/);
});

test('final subtraction removes RF2 exception descendants and preserves inhalers', async () => {
  const nativeFetch = globalThis.fetch;
  const vs: EmisValueSet = { id: 'test', codeSystem: 'SNOMED_CONCEPT', values: [
    { code: '100000', displayName: 'Synthetic refset', includeChildren: true, isRefset: true },
  ], exceptions: [exception] };
  const ointment = concept('200000', 'Synthetic ointment descendant');
  const inhaler = concept('10073911000001106', 'Easyhaler Budesonide');
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(init!.body as string);
    if (input === '/api/terminology/resolve-exceptions') return Response.json({ success: true, resolutions: [
      { originalCode: exception.code, code: '746901000001108', error: null },
    ] });
    if (input === '/api/terminology/rf2-refset') return Response.json({ success: true, refsets: { '100000': { members: [ointment, inhaler] } } });
    assert.equal(body.ecl, '<< 746901000001108');
    return Response.json({ success: true, total: 2, concepts: [concept('746901000001108', 'Budesonide ointment'), ointment] });
  };
  try {
    assert.deepEqual((await expandValueSetClientSide(vs, translations, {})).concepts.map(c => c.code), [inhaler.code]);
    assert.notEqual(generateExpansionKey(vs), generateExpansionKey({ ...vs, exceptions: [] }));
    assert.notEqual(generateExpansionKey(vs), generateExpansionKey({ ...vs, values: [{ ...vs.values[0], includeChildren: false }] }));
  } finally { globalThis.fetch = nativeFetch; }
});

test('quarantined sets export no partial expansion and retain the exception reason', async () => {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, resolutions: [{ originalCode: exception.code, code: null, error: 'No exact preparation' }] });
  try {
    const result = await expandValueSetClientSide({ id: 'test', values: [], exceptions: [exception] }, translations, {});
    assert.equal(result.concepts.length, 0);
    assert.match(result.expansionError!, /No exact preparation/);
    assert.equal(result.exceptionResolutions![0].code, null);
  } finally { globalThis.fetch = nativeFetch; }
});
