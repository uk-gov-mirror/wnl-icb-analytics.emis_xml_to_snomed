/** PR #6 round 2 corrections. Clinical sources and remaining review gates are in README.md. */
export const EXCEPTION_OVERRIDES: Array<{
  version: number; emisCode: string; emisDisplay: string;
  mode: 'dmd_family' | 'inactive_exact' | 'international_exact';
  targets: Array<{ code: string; display: string }>; reason: string; source: string;
}> = [
  { version: 1, emisCode: '1137341000033113', emisDisplay: 'Prednesol Soluble tablets 5 mg', mode: 'inactive_exact',
    targets: [{ code: '675201000001103', display: 'Prednesol 5mg tablet' }],
    reason: 'Prednesol contains prednisolone, not paracetamol. Retain the named inactive brand exactly; do not substitute all generic soluble tablets.',
    source: 'https://www.medicines.org.uk/emc/product/14675/smpc' },
  { version: 1, emisCode: '10210641000033117', emisDisplay: 'Loderm Topical solution 2 %', mode: 'dmd_family',
    targets: [{ code: '41739411000001106', display: 'Erythromycin 2% solution' }],
    reason: 'Loderm is topical erythromycin 2%, not ethanol. UK dm+d has no named Loderm product; use the matching formulation VMP.',
    source: 'https://cima.aemps.es/cima/rest/medicamento?nregistro=56857' },
  { version: 1, emisCode: '5491641000033115', emisDisplay: 'Caduet Tablets 5 mg + 10 mg', mode: 'international_exact',
    targets: [{ code: '1153436005', display: 'Amlodipine (as amlodipine besilate) 5 mg and atorvastatin (as atorvastatin calcium) 10 mg oral tablet' }],
    reason: 'Caduet 5/10 contains amlodipine/atorvastatin, not empagliflozin/linagliptin. No UK dm+d preparation found; exclude the specific international clinical drug exactly.',
    source: 'https://labeling.pfizer.com/ShowLabeling.aspx?id=22116' },
  { version: 1, emisCode: '540241000033110', emisDisplay: 'Erythromycin Topical solution', mode: 'dmd_family',
    targets: [{ code: '41739411000001106', display: 'Erythromycin 2% solution' }],
    reason: 'The XML explicitly excludes topical erythromycin solution. Resolve the international topical solution to the UK 2% solution VMP, including its AMPs.',
    source: 'PR #6 REVIEW_OPUS.md finding 3; UK SNOMED 20260923 dm+d hierarchy' },
];
