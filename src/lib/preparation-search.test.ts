import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findPreparationCandidates, expandEclQuery, classifyExceptionTarget } from './terminology-client';

const savedFetch = globalThis.fetch;
const savedEnv = { ACCESS_TOKEN_URL: process.env.ACCESS_TOKEN_URL, CLIENT_ID: process.env.CLIENT_ID, CLIENT_SECRET: process.env.CLIENT_SECRET };
async function withFetch(fn: typeof fetch, action: () => Promise<void>) {
  Object.assign(process.env, { ACCESS_TOKEN_URL: 'https://synthetic.invalid/token', CLIENT_ID: 'synthetic', CLIENT_SECRET: 'synthetic' });
  globalThis.fetch = (input, init) => String(input) === process.env.ACCESS_TOKEN_URL
    ? Promise.resolve(Response.json({ access_token: 'synthetic', expires_in: 3600 })) : fn(input, init);
  try { await action(); } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('active searches retry 429 and page through a smaller server page cap', async () => {
  let calls = 0;
  const offsets: number[] = [];
  await withFetch(async input => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('activeOnly'), 'true');
    assert.equal(url.searchParams.get('url'), 'http://snomed.info/sct?fhir_vs=ecl/(<10363801000001108 OR <10363901000001102)');
    const offset = Number(url.searchParams.get('offset') || 0);
    offsets.push(offset);
    if (++calls === 1) return new Response('', { status: 429 });
    return Response.json({ expansion: { total: 3, contains: [{ code: String(100000 + offset), display: 'Synthetic preparation' }] } });
  }, async () => {
    assert.equal((await findPreparationCandidates('Synthetic syrup')).length, 3);
    assert.deepEqual(offsets, [0, 0, 1, 2]);
  });
});

test('VMP and AMP roots cannot authorise preparation descendant subtraction', async () => {
  await withFetch(async () => { throw Error('Roots must be rejected before lookup'); }, async () => {
    for (const root of ['10363801000001108', '10363901000001102']) {
      assert.equal(await classifyExceptionTarget(root), 'ingredient_family');
    }
  });
});

test('active search rejects missing pages and ignored offsets', async () => {
  await withFetch(async () => Response.json({ expansion: { total: 2, contains: [] } }), async () => {
    await assert.rejects(findPreparationCandidates('Synthetic'), /incomplete/);
  });
  await withFetch(async () => Response.json({ expansion: { total: 2, contains: [{ code: '100000', display: 'Synthetic' }] } }), async () => {
    await assert.rejects(findPreparationCandidates('Synthetic'), /repeated/);
  });
});

test('server ECL expansion respects total despite a smaller page cap and refuses partial results', async () => {
  const offsets: number[] = [];
  await withFetch(async input => {
    const offset = Number(new URL(String(input)).searchParams.get('offset'));
    offsets.push(offset);
    return Response.json({ expansion: { total: 3, contains: [{ code: String(100000 + offset), display: 'Synthetic' }] } });
  }, async () => {
    assert.equal((await expandEclQuery('<< 100000')).length, 3);
    assert.deepEqual(offsets, [0, 1, 2]);
  });
  await withFetch(async () => Response.json({ expansion: { total: 3, contains: [] } }), async () => {
    await assert.rejects(expandEclQuery('<< 100000'), /no further page/);
  });
  await withFetch(async () => Response.json({ expansion: { total: 3, contains: [{ code: '100000', display: 'Synthetic' }] } }), async () => {
    await assert.rejects(expandEclQuery('<< 100000'), /repeated page/);
  });
});

test('hierarchy guard recognises VMP before its VTM and medicinal-product ancestors using a real cached expansion', async () => {
  // UK SNOMED 20260923, read-only terminology-server expansion retained on 22 October 2026.
  const evidence = JSON.parse(readFileSync(new URL('./fixtures/erythromycin-ancestors.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
  assert.ok(evidence.concepts.some((c: { code: string }) => c.code === '10363801000001108'));
  await withFetch(async () => Response.json({ expansion: { total: evidence.total, contains: evidence.concepts } }), async () => {
    assert.equal(await classifyExceptionTarget('41739411000001106'), 'preparation');
  });
  for (const root of ['105590001', '373873005', '10363701000001104']) {
    const rows = [...new Set(['100000', root, '373873005', '138875005'])].map(code => ({ code, display: 'Uninformative label' }));
    await withFetch(async () => Response.json({ expansion: { total: rows.length, contains: rows } }), async () => {
      assert.equal(await classifyExceptionTarget('100000'), 'ingredient_family');
    });
  }
});
