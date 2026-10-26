import assert from 'node:assert/strict';
import test from 'node:test';
import { expandSctConstProducts } from './sct-const-expander';
import { buildModificationOfEcl } from './ecl-builder';
import type { SnomedConcept } from './types';

const concept = (code: string): SnomedConcept => ({ code, display: code, system: 'http://snomed.info/sct', source: 'terminology_server' });

test('finds atorvastatin products through calcium trihydrate and terminates on cycles', async () => {
  const queries: string[] = [];
  const result = await expandSctConstProducts('373444002', [], async (ecl) => {
    queries.push(ecl);
    if (ecl === buildModificationOfEcl('373444002')) return [concept('108601004')];
    if (ecl === buildModificationOfEcl('108601004')) return [concept('725658002')];
    if (ecl === buildModificationOfEcl('725658002')) return [concept('108601004'), concept('373444002')];
    assert.ok(ecl.includes('762949000 = << 725658002'));
    return ['39695411000001103', '39733011000001106', '39733111000001107'].map(concept);
  });
  assert.equal(result.products.length, 3);
  assert.equal(queries.length, 4);
});

test('subtracts every product exception with descendants from the complete product union', async () => {
  const result = await expandSctConstProducts('373444002', ['123456', '234567'], async (ecl) => {
    if (ecl === buildModificationOfEcl('373444002')) return [concept('567890')];
    if (ecl === buildModificationOfEcl('567890')) return [];
    assert.equal(ecl, '((<< (< 10363601000001109 : 762949000 = << 373444002)) OR (<< (< 10363601000001109 : 762949000 = << 567890))) MINUS (<< 123456 OR << 234567)');
    const products = ['123456', '234567', '345678', '456789'];
    const descendants: Record<string, string[]> = { '123456': ['345678'], '234567': [] };
    const excluded = new Set<string>();
    for (const match of ecl.split(' MINUS ')[1].matchAll(/<< (\d+)/g)) {
      excluded.add(match[1]);
      for (const child of descendants[match[1]]) excluded.add(child);
    }
    return products.filter((code) => !excluded.has(code)).map(concept);
  });
  assert.deepEqual(result.products.map((c) => c.code), ['456789']);
});

test('does not return partial products if a modification query fails', async () => {
  await assert.rejects(expandSctConstProducts('373444002', [], async () => {
    throw new Error('terminology unavailable');
  }), /terminology unavailable/);
});


// Fixture substances and products; precise ingredient and basis of strength (BoSS) follow dm+d.
const PRED = '116601002', ACETATE = '96334000', HEXANOATE = '438443002', SODIUM_PHOSPHATE = '96335004';
const FORMOTEROL_FUMARATE = '129490002', FORMOTEROL_FUMARATE_DIHYDRATE = '447213002';
const modificationsOf: Record<string, string[]> = {
  [PRED]: [ACETATE, HEXANOATE, SODIUM_PHOSPHATE],
  [FORMOTEROL_FUMARATE]: [FORMOTEROL_FUMARATE_DIHYDRATE],
};
const products = [
  { code: 'pred-tablets', precise: PRED, boss: PRED },
  { code: 'pred-forte', precise: ACETATE, boss: ACETATE },
  { code: 'scheriproct', precise: HEXANOATE, boss: HEXANOATE },
  { code: 'predsol-eye-drops', precise: SODIUM_PHOSPHATE, boss: SODIUM_PHOSPHATE },
  { code: 'pred-soluble-tablets', precise: SODIUM_PHOSPHATE, boss: PRED },
  { code: 'formoterol-inhaler', precise: FORMOTEROL_FUMARATE_DIHYDRATE, boss: FORMOTEROL_FUMARATE_DIHYDRATE },
];
const ownConstituents = new Set([PRED, ACETATE, HEXANOATE, SODIUM_PHOSPHATE, FORMOTEROL_FUMARATE]);

/** Evaluates the modification and product ECL shapes the expander builds. */
async function fakeTerminology(ecl: string): Promise<SnomedConcept[]> {
  const modification = Object.keys(modificationsOf).find((code) => ecl === buildModificationOfEcl(code));
  if (modification) return modificationsOf[modification].map(concept);
  if (ecl.startsWith('<< 105590001')) return [];
  const terms = [...ecl.matchAll(/762949000 = << (\d+)(?:, 732943007 = << (\d+))?\)/g)];
  assert.ok(terms.length > 0, ecl);
  return products.filter((p) => terms.some(([, precise, boss]) => p.precise === precise && (!boss || p.boss === boss))).map((p) => concept(p.code));
}

async function expandValueSet(listed: string[]) {
  const codes = new Set<string>();
  for (const substance of listed) {
    const { products: found } = await expandSctConstProducts(substance, [], fakeTerminology, [], {
      listedSubstances: listed,
      findConstituentSubstances: async (candidates) => candidates.filter((code) => ownConstituents.has(code)),
    });
    for (const product of found) codes.add(product.code);
  }
  return [...codes].sort();
}

test('excludes prednisolone acetate and hexanoate products, which EMIS holds as separate constituents', async () => {
  const codes = await expandValueSet([PRED, SODIUM_PHOSPHATE]);
  assert.ok(!codes.includes('pred-forte'));
  assert.ok(!codes.includes('scheriproct'));
});

test('keeps sodium phosphate products where listed, otherwise only those with prednisolone strength', async () => {
  assert.deepEqual(await expandValueSet([PRED, SODIUM_PHOSPHATE]), ['pred-soluble-tablets', 'pred-tablets', 'predsol-eye-drops']);
  assert.deepEqual(await expandValueSet([PRED]), ['pred-soluble-tablets', 'pred-tablets']);
});

test('keeps formoterol fumarate dihydrate, a modification without its own EMIS constituent', async () => {
  assert.deepEqual(await expandValueSet([FORMOTEROL_FUMARATE]), ['formoterol-inhaler']);
});

test('follows every modification when no constituent lookup is given', async () => {
  const withoutLookup = await expandSctConstProducts(PRED, [], fakeTerminology);
  assert.deepEqual(withoutLookup.stoppedModifications, []);
  assert.equal(withoutLookup.products.length, 5);
});
