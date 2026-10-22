import { buildModificationOfEcl, buildUkProductEcl } from './ecl-builder';
import type { SnomedConcept } from './types';

/** Expand modifications to a fixed point, querying each substance once. */
export async function expandSctConstProducts(
  substanceCode: string,
  excludedCodes: string[],
  expand: (ecl: string) => Promise<SnomedConcept[]>,
  exactExcludedCodes: string[] = [],
) {
  const substances = new Set([substanceCode]);
  const modificationEcls: string[] = [];
  for (const code of substances) {
    const ecl = buildModificationOfEcl(code);
    modificationEcls.push(ecl);
    const modifications = await expand(ecl);
    for (const modification of modifications) substances.add(modification.code);
  }

  let productEcl = Array.from(substances, (code) => `(${buildUkProductEcl(code)})`).join(' OR ');
  if (excludedCodes.length > 0 || exactExcludedCodes.length > 0) {
    const exclusions = [...Array.from(new Set(excludedCodes), (code) => `<< ${code}`), ...new Set(exactExcludedCodes)].join(' OR ');
    productEcl = `(${productEcl}) MINUS (${exclusions})`;
  }
  return { products: await expand(productEcl), productEcl, modificationEcls };
}
