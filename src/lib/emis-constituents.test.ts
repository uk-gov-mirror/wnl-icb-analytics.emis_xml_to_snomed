import assert from 'node:assert/strict';
import test from 'node:test';
import { findEmisConstituentSubstances, isEmisConstituentCode } from './terminology-client';

test('recognises EMIS constituent IDs only', () => {
  assert.ok(isEmisConstituentCode('124121000033110'));
  assert.ok(!isEmisConstituentCode('1137341000033113'));
  assert.ok(!isEmisConstituentCode('7336381000006114'));
});

test('reports substances with an equivalent EMIS constituent from reverse translation', async () => {
  const nativeFetch = globalThis.fetch;
  process.env.ACCESS_TOKEN_URL = 'https://auth.test/token';
  process.env.CLIENT_ID = 'id';
  process.env.CLIENT_SECRET = 'secret';
  const match = (code: string, equivalence: string) => ({ name: 'match', part: [
    { name: 'equivalence', valueCode: equivalence },
    { name: 'concept', valueCoding: { system: 'http://LDS.nhs/EMIS/CodeID/cs', code } },
  ] });
  const resources: Record<string, unknown[]> = {
    '96334000': [match('4070571000006110', 'equivalent'), match('124121000033110', 'equivalent')],
    '447213002': [match('7336381000006114', 'equivalent')],
    '116601002': [match('124021000033114', 'inexact')],
  };
  let reverse = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://auth.test')) return Response.json({ access_token: 't', expires_in: 3600 });
    if (url.includes('ConceptMap?url=')) return Response.json({ entry: [{ resource: { id: 'cm', version: '1' } }] });
    const bundle = JSON.parse(String(init?.body));
    return Response.json({ entry: bundle.entry.map((e: any) => {
      const params = e.resource.parameter;
      reverse ||= params.some((p: any) => p.name === 'reverse' && p.valueBoolean === true);
      const code = params.find((p: any) => p.name === 'code').valueCode;
      return { response: { status: '200' }, resource: { resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: true }, ...resources[code]] } };
    }) });
  }) as typeof fetch;
  try {
    assert.deepEqual(await findEmisConstituentSubstances(['96334000', '447213002', '116601002']), ['96334000']);
    assert.ok(reverse);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
