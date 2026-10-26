import { buildModificationOfEcl, buildUkProductEcl } from './ecl-builder';
import type { SnomedConcept } from './types';

const UK_PRODUCT_CONCEPT = '10363601000001109';
const HAS_PRECISE_ACTIVE_INGREDIENT = '762949000';
const HAS_BASIS_OF_STRENGTH_SUBSTANCE = '732943007';

export interface SctConstOptions {
  /** Every translated SCT_CONST substance in the value set. */
  listedSubstances?: string[];
  /** Returns the substances, from those given, that have their own EMIS constituent code. */
  findConstituentSubstances?: (substanceCodes: string[]) => Promise<string[]>;
}

/**
 * Expand modifications to a fixed point, querying each substance once.
 *
 * A modification with its own EMIS constituent is not followed: EMIS indexes its
 * products under that constituent, which the value set must list to include them.
 * Its products stay only if their basis-of-strength substance is a listed substance.
 */
export async function expandSctConstProducts(
  substanceCode: string,
  excludedCodes: string[],
  expand: (ecl: string) => Promise<SnomedConcept[]>,
  exactExcludedCodes: string[] = [],
  options: SctConstOptions = {},
) {
  const substances = new Set([substanceCode]);
  const stopped = new Set<string>();
  const modificationEcls: string[] = [];
  for (const code of substances) {
    const ecl = buildModificationOfEcl(code);
    modificationEcls.push(ecl);
    const found = [...new Set((await expand(ecl)).map((m) => m.code))].filter((m) => !substances.has(m) && !stopped.has(m));
    const ownConstituent = new Set(found.length && options.findConstituentSubstances ? await options.findConstituentSubstances(found) : []);
    for (const modification of found) (ownConstituent.has(modification) ? stopped : substances).add(modification);
  }

  const terms = Array.from(substances, (code) => `(${buildUkProductEcl(code)})`);
  const listed = [...new Set([substanceCode, ...(options.listedSubstances || [])])];
  if (stopped.size > 0) {
    // One term keeps the GET URL short; same members as one term per pair.
    terms.push(`(<< (< ${UK_PRODUCT_CONCEPT} : ${HAS_PRECISE_ACTIVE_INGREDIENT} = << (${[...stopped].join(' OR ')}), ${HAS_BASIS_OF_STRENGTH_SUBSTANCE} = << (${listed.join(' OR ')})))`);
  }
  let productEcl = terms.join(' OR ');
  if (excludedCodes.length > 0 || exactExcludedCodes.length > 0) {
    const exclusions = [...Array.from(new Set(excludedCodes), (code) => `<< ${code}`), ...new Set(exactExcludedCodes)].join(' OR ');
    productEcl = `(${productEcl}) MINUS (${exclusions})`;
  }
  return { products: await expand(productEcl), productEcl, modificationEcls, stoppedModifications: [...stopped] };
}
