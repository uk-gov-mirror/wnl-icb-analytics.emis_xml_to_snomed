import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExceptions, exceptionError } from './exception-resolver';
import { expandValueSetClientSide } from './client-valueset-expander';
import { generateExpansionKey } from './valueset-utils';
import { buildExceptionsMetadata } from './batch-assembly';
import { buildBatchedEclQuery, buildModificationOfEcl } from './ecl-builder';
import { EmisValueSet, SnomedConcept } from './types';

const concept = (code: string, display: string): SnomedConcept => ({ code, display, system: 'http://snomed.info/sct', source: 'terminology_server' });
const exception = { code: '170041000033114', displayName: 'Budesonide Ointment 0.025 %' };
const translations = { [exception.code]: { code: '108622005', display: 'Budesonide-containing product' } };
const none = async () => [];
const ointment = concept('746901000001108', 'Budesonide 0.025% ointment');
const inhaler = concept('10073911000001106', 'Easyhaler Budesonide');

test('an exact active VMP family takes precedence over inactive products and ingredient groupers', async () => {
  const result = await resolveExceptions([exception], translations, {}, async () => [ointment, inhaler],
    async () => { throw Error('inactive search must not run'); });
  assert.equal(result[0].code, ointment.code);
  assert.equal(result[0].status, 'resolved_family');
  assert.equal(result[0].includeDescendants, true);
  assert.equal(exceptionError(result), undefined);
});

test('an exact inactive preparation excludes its original code without historical substitution', async () => {
  const result = await resolveExceptions([exception], translations, { [ointment.code]: '108622005' }, none,
    async () => [ointment, ointment, inhaler]);
  assert.equal(result[0].code, ointment.code);
  assert.equal(result[0].status, 'inactive_exact');
  assert.equal(result[0].includeDescendants, true);
  assert.equal(exceptionError(result), undefined);
});

test('missing, ambiguous and different-strength preparations preserve the loaded exact target', async () => {
  for (const candidates of [[], [concept('100001', 'Budesonide 0.05% ointment')],
    [concept('100001', 'Budesonide 0.025% ointment'), concept('100002', 'Budesonide 0.025% ointment')]]) {
    const result = await resolveExceptions([exception], translations, {}, async () => candidates,
      async () => candidates, { [exception.code]: '395726003' });
    assert.equal(result[0].code, '395726003');
    assert.equal(result[0].status, 'legacy_exact');
    assert.equal(result[0].includeDescendants, false);
    assert.match(result[0].reason, /review preparation/);
    assert.equal(exceptionError(result), undefined);
  }
});

test('a loaded null target stays null even when the current ConceptMap has a translation', async () => {
  const result = await resolveExceptions([exception], translations, {}, none, none, { [exception.code]: null });
  assert.equal(result[0].code, null);
  assert.equal(result[0].status, 'legacy_exact');
  assert.match(result[0].reason, /no translated target/);
  assert.equal(exceptionError(result), undefined);
  await assert.rejects(resolveExceptions([exception], translations, {}, none, none, {}), /Missing legacy exception target/);
});

test('combination preparations cannot swap the strengths of their ingredients', async () => {
  const result = await resolveExceptions([{ code: '100000', displayName: 'DrugA 10mg / DrugB 20mg tablets' }], {}, {},
    async () => [concept('100001', 'DrugA 20mg / DrugB 10mg tablets')], none);
  assert.equal(result[0].code, null);
  assert.equal(result[0].status, 'legacy_exact');
});

test('unmapped clinical exceptions retain the legacy omission and terminology failures propagate', async () => {
  const result = await resolveExceptions([{ code: '100001', displayName: 'Synthetic diagnosis' }], {}, {}, none, none);
  assert.equal(result[0].code, null);
  assert.equal(result[0].status, 'legacy_exact');
  assert.match(result[0].reason, /No accepted ConceptMap translation/);
  assert.equal(exceptionError(result), undefined);
  await assert.rejects(resolveExceptions([exception], translations, {}, async () => { throw Error('unavailable'); }, none), /unavailable/);
  await assert.rejects(resolveExceptions([exception], translations, {}, none, async () => { throw Error('unavailable'); }), /unavailable/);
});

test('final subtraction removes inactive product descendants from RF2 and preserves inhalers', async () => {
  const nativeFetch = globalThis.fetch;
  const vs: EmisValueSet = { id: 'test', codeSystem: 'SNOMED_CONCEPT', values: [
    { code: '100000', displayName: 'Synthetic refset', includeChildren: true, isRefset: true },
  ], exceptions: [exception] };
  const child = concept('200000', 'Synthetic ointment descendant');
  const resolutions = await resolveExceptions([exception], translations, {}, none, async () => [ointment]);
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(init!.body as string);
    if (input === '/api/terminology/resolve-exceptions') return Response.json({ success: true, resolutions });
    if (input === '/api/terminology/rf2-refset') return Response.json({ success: true, refsets: { '100000': { members: [ointment, child, inhaler] } } });
    assert.equal(body.ecl, '<< 746901000001108');
    return Response.json({ success: true, total: 2, concepts: [ointment, child] });
  };
  try {
    const result = await expandValueSetClientSide(vs, translations, {});
    assert.deepEqual(result.concepts.map(c => c.code), [inhaler.code]);
    assert.equal(result.exceptionResolutions![0].status, 'inactive_exact');
    assert.notEqual(generateExpansionKey(vs), generateExpansionKey({ ...vs, exceptions: [] }));
    assert.notEqual(generateExpansionKey(vs), generateExpansionKey({ ...vs, values: [{ ...vs.values[0], includeChildren: false }] }));
  } finally { globalThis.fetch = nativeFetch; }
});

test('legacy ingredient groupers never subtract inhaler descendants in RF2, ordinary ECL or SCT_CONST', async () => {
  const nativeFetch = globalThis.fetch;
  const resolutions = await resolveExceptions([exception], translations, {}, none, none);
  const grouper = concept('108622005', 'Budesonide-containing product');
  try {
    for (const mode of ['rf2', 'ordinary', 'sct_const']) {
      const vs: EmisValueSet = { id: 'test', codeSystem: mode === 'sct_const' ? 'SCT_CONST' : 'SNOMED_CONCEPT',
        values: [{ code: '100000', displayName: 'Synthetic root', includeChildren: true, isRefset: mode === 'rf2' }], exceptions: [exception] };
      const queries: string[] = [];
      globalThis.fetch = async (input, init) => {
        const body = JSON.parse(init!.body as string);
        if (input === '/api/terminology/resolve-exceptions') return Response.json({ success: true, resolutions });
        if (input === '/api/terminology/rf2-refset') return Response.json({ success: true,
          refsets: { '100001': { members: [grouper, ointment, inhaler] } } });
        queries.push(body.ecl);
        assert.ok(!body.ecl.includes('<< 108622005'), body.ecl);
        if (body.ecl === buildModificationOfEcl('100001')) return Response.json({ success: true, total: 0, concepts: [] });
        assert.ok(body.ecl.endsWith('MINUS (108622005)'), body.ecl);
        return Response.json({ success: true, total: 2, concepts: [ointment, inhaler] });
      };
      const result = await expandValueSetClientSide(vs, { '100000': { code: '100001' }, ...translations }, {});
      assert.deepEqual(result.concepts.map(c => c.code).sort(), [ointment.code, inhaler.code].sort(), mode);
      assert.equal(result.expansionError, undefined);
      if (mode === 'rf2') assert.equal(queries.length, 0);
      const metadata = buildExceptionsMetadata([exception.code], [exception.displayName], translations, {}, resolutions);
      assert.equal(metadata[0].resolutionStatus, 'legacy_exact');
      assert.equal(metadata[0].includeDescendants, false);
    }
  } finally { globalThis.fetch = nativeFetch; }
});

test('mixed ECL exclusions retain descendant and exact scopes', () => {
  assert.equal(buildBatchedEclQuery([{ code: '100000', displayName: 'Synthetic root', includeChildren: true }], [ointment.code], undefined, ['108622005']),
    '(<< 100000) MINUS (<< 746901000001108 OR 108622005)');
});
