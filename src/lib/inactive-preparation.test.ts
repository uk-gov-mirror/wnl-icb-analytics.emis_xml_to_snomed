import test from 'node:test';
import assert from 'node:assert/strict';
import { findInactivePreparationCandidates } from './terminology-client';

test('inactive preparation search pages completely and rejects active products and non-dm+d codes', async () => {
  const nativeFetch = globalThis.fetch;
  const saved = { ACCESS_TOKEN_URL: process.env.ACCESS_TOKEN_URL, CLIENT_ID: process.env.CLIENT_ID, CLIENT_SECRET: process.env.CLIENT_SECRET };
  Object.assign(process.env, { ACCESS_TOKEN_URL: 'https://synthetic.invalid/token', CLIENT_ID: 'synthetic', CLIENT_SECRET: 'synthetic' });
  const offsets: string[] = [];
  globalThis.fetch = async input => {
    if (String(input) === process.env.ACCESS_TOKEN_URL) return Response.json({ access_token: 'synthetic', expires_in: 3600 });
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('activeOnly'), 'false');
    assert.equal(url.searchParams.get('filter'), 'Budesonide');
    offsets.push(url.searchParams.get('offset')!);
    return Response.json({ expansion: { total: 4, contains: offsets.length === 1 ? [
      { code: '746901000001108', display: 'Budesonide 0.025% ointment', inactive: true },
      { code: '108622005', display: 'Budesonide-containing product', inactive: true },
    ] : [
      { code: '10073911000001106', display: 'Easyhaler Budesonide', inactive: false },
      { code: '1231000001101', display: 'Synthetic inactive product', inactive: true },
    ] } });
  };
  try {
    assert.deepEqual((await findInactivePreparationCandidates('Budesonide ointment 0.025%')).map(c => c.code),
      ['746901000001108', '1231000001101']);
    assert.deepEqual(offsets, ['0', '2']);
    globalThis.fetch = async () => Response.json({ expansion: { total: 1, contains: [] } });
    await assert.rejects(findInactivePreparationCandidates('Budesonide ointment 0.025%'), /incomplete/);
  } finally {
    globalThis.fetch = nativeFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
