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

