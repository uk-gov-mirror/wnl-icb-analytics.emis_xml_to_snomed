import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranslateResponse, batchTranslateEmisCodes } from './terminology-client';
import { buildNormalizedTables } from './batch-assembly';
import { ConceptMapTranslateResponse, EmisReport } from './types';

test('FHIR equivalence is retained exactly, including wider and inexact', () => {
  for (const equivalence of ['equivalent', 'wider', 'narrower', 'inexact']) {
    const response: ConceptMapTranslateResponse = { resourceType: 'Parameters', parameter: [
      { name: 'result', valueBoolean: true }, { name: 'match', part: [
        { name: 'equivalence', valueCode: equivalence },
        { name: 'concept', valueCoding: { code: '100000', system: 'http://snomed.info/sct' } },
      ] },
    ] };
    assert.equal(parseTranslateResponse(response, [equivalence])?.equivalence, equivalence);
    if (equivalence === 'wider' || equivalence === 'inexact') assert.equal(parseTranslateResponse(response, ['equivalent', 'narrower']), null);
  }
});

test('normalised exports retain equivalence for accepted, rejected and unmapped original codes', () => {
  const report = { id: 'report', name: 'Synthetic report', rule: 'test.xml', valueSets: [] } as unknown as EmisReport;
  const codes = ['equivalent', 'wider', 'narrower', 'inexact', 'unmapped'];
  const vs = { id: 'test', codeSystem: 'SNOMED_CONCEPT', values: codes.map(code => ({ code, displayName: code, includeChildren: true })), exceptions: [] };
  const translations = { equivalent: { code: '100000', equivalence: 'equivalent' }, narrower: { code: '100001', equivalence: 'narrower' } };
  const tables = buildNormalizedTables([report], [{ report, vs, hash: 'hash', vsIndex: 0 }], new Map(), new Map([['hash', 'quarantined']]), translations, {}, 'strict', Object.fromEntries(codes.map(c => [c, c])));
  assert.deepEqual(tables.originalCodes.map(c => c.translation_equivalence), codes);
  assert.equal(tables.originalCodes[1].translated_to_snomed_code, '');
  assert.equal(tables.originalCodes[0].translated_to_snomed_code, '100000');
  assert.equal(tables.valuesets[0].expansion_error, 'quarantined');
  assert.equal(Object.keys(tables.originalCodes[0]).at(-1), 'translation_equivalence');
});

test('batch translation keeps rejected primary equivalence without changing filter policy', async () => {
  const nativeFetch = globalThis.fetch;
  const oldEnv = { ACCESS_TOKEN_URL: process.env.ACCESS_TOKEN_URL, CLIENT_ID: process.env.CLIENT_ID, CLIENT_SECRET: process.env.CLIENT_SECRET };
  Object.assign(process.env, { ACCESS_TOKEN_URL: 'https://synthetic.invalid/token', CLIENT_ID: 'synthetic', CLIENT_SECRET: 'synthetic' });
  let failure = false;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/token')) return Response.json({ access_token: 'synthetic', expires_in: 3600 });
    if (!init?.body) return Response.json({ entry: [{ resource: { id: String(input).includes('DrugCodeID') ? 'fallback' : 'primary', version: 'synthetic' } }] });
    const body = JSON.parse(init.body as string);
    return Response.json({ entry: body.entry.map((entry: any) => ({ response: { status: failure ? '500' : '200' }, resource: {
      resourceType: 'Parameters', parameter: entry.request.url.includes('fallback') ? [{ name: 'result', valueBoolean: false }] : [
        { name: 'result', valueBoolean: true }, { name: 'match', part: [
          { name: 'equivalence', valueCode: 'wider' },
          { name: 'concept', valueCoding: { code: '100000', system: 'http://snomed.info/sct' } },
        ] },
      ],
    } })) });
  };
  try {
    const equivalences: Record<string, string> = {};
    assert.equal((await batchTranslateEmisCodes(['100001'], 'strict', equivalences))['100001'], null);
    assert.equal(equivalences['100001'], 'wider');
    const allEquivalences: Record<string, string> = {};
    assert.equal((await batchTranslateEmisCodes(['100001'], 'all', allEquivalences))['100001'], null);
    assert.equal(allEquivalences['100001'], 'wider');
    failure = true;
    await assert.rejects(batchTranslateEmisCodes(['100001'], 'strict'), /Incomplete ConceptMap translation response/);
  } finally {
    globalThis.fetch = nativeFetch;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
