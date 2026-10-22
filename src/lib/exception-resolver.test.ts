import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExceptions, exceptionError, exceptionExclusions, preparationKey } from './exception-resolver';
import { expandValueSetClientSide } from './client-valueset-expander';
import { generateExpansionKey } from './valueset-utils';
import { buildExceptionsMetadata } from './batch-assembly';
import { buildBatchedEclQuery, buildModificationOfEcl } from './ecl-builder';
import { EXCEPTION_OVERRIDES } from './exception-overrides';
import { exceptionTranslationMismatches } from './exception-mismatches';
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
  assert.equal(result[0].includeDescendants, false);
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
  const resolutions = await resolveExceptions([exception], translations, {}, none, async () => [ointment], undefined,
    { classifyTarget: async code => code === ointment.code ? 'preparation' : 'ingredient_family' });
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


test('device and syrup exceptions cannot subtract a substance, VTM or medicinal-product family', async () => {
  for (const displayName of ['Synthetic Turbohaler 200/6', 'Synthetic Easyhaler', 'Synthetic Ellipta', 'Synthetic Respimat', 'Synthetic syrup']) {
    for (const codeSystem of ['SCT_CONST', 'SCT_PREP', 'DrugCodeID', 'SNOMED_CONCEPT']) {
      const result = await resolveExceptions([{ code: '100000', displayName }], { '100000': { code: '200000', display: 'Uninformative label' } }, {}, none, none,
        { '100000': '200000' }, { codeSystem, classifyTarget: async () => 'ingredient_family' });
      assert.equal(result[0].status, 'legacy_exact');
      assert.deepEqual(exceptionExclusions(result), { descendantCodes: [], exactCodes: ['200000'] });
    }
  }
});

test('clinical units and dosage-form words do not change a structurally clinical exclusion', async () => {
  const result = await resolveExceptions([{ code: '100000', displayName: 'Synthetic clinical ratio 30 mg/mmol' }],
    { '100000': { code: '200000' } }, {}, async () => { throw Error('No product search'); }, none, undefined,
    { codeSystem: 'SNOMED_CONCEPT', classifyTarget: async () => 'clinical' });
  assert.equal(result[0].includeDescendants, true);
});

test('normalisation permits form position and plurals but retains device, strength, qualifiers and supplier', () => {
  assert.equal(preparationKey('Synthetic tablets 5 mg'), preparationKey('Synthetic 5mg tablet'));
  assert.equal(preparationKey('Synthetic cream 0.025 %'), preparationKey('Synthetic 0.025% cream'));
  for (const different of ['Synthetic 10mg tablet', 'Synthetic 5mg tablet sugar free', 'Synthetic 5mg tablet (Supplier)', 'Synthetic 5mg tablet Easyhaler']) {
    assert.notEqual(preparationKey('Synthetic 5mg tablet'), preparationKey(different));
  }
});

test('VMP and AMP sharing a name remain ambiguous, and inactive matching retains a working loaded product', async () => {
  const a = concept('100001', 'Synthetic 5mg tablet');
  const b = concept('100002', 'Synthetic 5mg tablet');
  const item = { code: '100000', displayName: 'Synthetic tablets 5mg' };
  const ambiguous = await resolveExceptions([item], {}, {}, async () => [a, b], none, { '100000': null }, { codeSystem: 'SCT_PREP' });
  assert.equal(ambiguous[0].status, 'legacy_exact');
  const retained = await resolveExceptions([item], {}, {}, none, async () => [a], { '100000': b.code },
    { codeSystem: 'SCT_CONST', classifyTarget: async () => 'preparation' });
  assert.deepEqual(exceptionExclusions(retained).descendantCodes, [a.code, b.code]);
  assert.match(retained[0].reason, /retain working active/);
});

test('reviewed overrides precede wrong ConceptMap and loaded targets, with explicit scope and version', async () => {
  for (const override of EXCEPTION_OVERRIDES) {
    const candidates = [...override.targets, ...(override.exactTargets || [])].map(t => concept(t.code, t.display));
    const result = await resolveExceptions([{ code: override.emisCode, displayName: override.emisDisplay }],
      { [override.emisCode]: { code: '999999', display: 'Known wrong ingredient' } }, {},
      async () => candidates, async () => candidates, { [override.emisCode]: '999999' },
      { codeSystem: 'SCT_CONST', classifyTarget: async () => 'preparation', findExactTarget: async () => candidates });
    assert.equal(result[0].code, override.targets[0].code);
    assert.equal(result[0].overrideVersion, override.version);
    assert.equal(result[0].includeDescendants, override.mode === 'dmd_family');
    assert.match(result[0].reason, /Exception override/);
    await assert.rejects(resolveExceptions([{ code: override.emisCode, displayName: override.emisDisplay }], {}, {}, none, none), /failed terminology validation/);
  }
});

test('topical erythromycin override removes its VMP and AMP from a COPD antibiotic expansion', async () => {
  const override = EXCEPTION_OVERRIDES.find(o => o.emisCode === '540241000033110')!;
  const topical = concept('41739411000001106', 'Erythromycin 2% solution');
  const amp = concept('100002', 'Synthetic topical AMP');
  const oral = concept('100003', 'Synthetic oral antibiotic');
  const international = concept('332346003', 'Erythromycin 20 mg/mL cutaneous solution');
  const resolutions = await resolveExceptions([{ code: override.emisCode, displayName: override.emisDisplay }], {}, {}, async () => [topical], none,
    undefined, { codeSystem: 'SCT_CONST', classifyTarget: async () => 'preparation', findExactTarget: async () => [international] });
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (input === '/api/terminology/resolve-exceptions') return Response.json({ success: true, resolutions });
    const { ecl } = JSON.parse(init!.body as string);
    const concepts = ecl === '<< 41739411000001106' ? [topical, amp] : [topical, amp, international, oral];
    return Response.json({ success: true, total: concepts.length, concepts });
  };
  try {
    const result = await expandValueSetClientSide({ id: 'copd', codeSystem: 'SNOMED_CONCEPT', values: [{ code: oral.code, displayName: oral.display, includeChildren: true }],
      exceptions: [{ code: override.emisCode, displayName: override.emisDisplay }] }, {}, {});
    assert.deepEqual(result.concepts.map(c => c.code), [oral.code]);
  } finally { globalThis.fetch = nativeFetch; }
});

test('unrelated target names are review candidates and never automatic replacements', () => {
  const mismatches = exceptionTranslationMismatches([
    { code: '100000', displayName: 'SyntheticIngredient 5mg tablets' },
    { code: '100001', displayName: 'OtherIngredient 10mg tablets' },
  ], { '100000': { code: '200000', display: 'WrongIngredient 5mg tablets' }, '100001': { code: '200001', display: 'OtherIngredient 10mg tablet' } });
  assert.deepEqual(mismatches.map(m => m.originalCode), ['100000']);
  assert.equal(mismatches[0].overrideVersion, null);
});


test('an inactive match without verified preparation ancestry never subtracts descendants', async () => {
  const result = await resolveExceptions([{ code: '100000', displayName: 'Synthetic device' }], {}, {}, none,
    async () => [concept('100001', 'Synthetic device')], { '100000': '100002' },
    { codeSystem: 'SCT_PREP', classifyTarget: async () => 'unknown' });
  assert.equal(result[0].status, 'inactive_exact');
  assert.deepEqual(exceptionExclusions(result), { descendantCodes: [], exactCodes: ['100001'] });
});


test('a target with no current ancestry falls back exactly without a broad name search', async () => {
  const result = await resolveExceptions([{ code: '100000', displayName: 'Disorder synthetic' }], { '100000': { code: '100001' } }, {},
    async () => { throw Error('No product search for unknown clinical targets'); }, none,
    { '100000': '100002' }, { codeSystem: 'SNOMED_CONCEPT', classifyTarget: async () => 'unknown' });
  assert.equal(result[0].code, '100002');
  assert.equal(result[0].status, 'legacy_exact');
  assert.equal(result[0].includeDescendants, false);
});


test('an inactive exact target and a retained active family keep independent scopes', async () => {
  const result = await resolveExceptions([{ code: '100000', displayName: 'Synthetic 5mg tablet' }], {}, {}, none,
    async () => [concept('100001', 'Synthetic 5mg tablet')], { '100000': '100002' },
    { codeSystem: 'SCT_PREP', classifyTarget: async code => code === '100002' ? 'preparation' : 'unknown' });
  assert.deepEqual(exceptionExclusions(result), { descendantCodes: ['100002'], exactCodes: ['100001'] });
});
