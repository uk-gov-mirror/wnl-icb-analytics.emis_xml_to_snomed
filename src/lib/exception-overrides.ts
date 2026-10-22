/** Versioned XML exception corrections, validated against the cited product definitions. */
export const EXCEPTION_OVERRIDES: Array<{
  version: number; emisCode: string; emisDisplay: string;
  mode: 'dmd_family' | 'inactive_exact' | 'international_exact';
  targets: Array<{ code: string; display: string }>; exactTargets?: Array<{ code: string; display: string }>; reason: string; source: string;
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
  { version: 2, emisCode: '540241000033110', emisDisplay: 'Erythromycin Topical solution', mode: 'dmd_family',
    targets: [{ code: '41739411000001106', display: 'Erythromycin 2% solution' }],
    exactTargets: [{ code: '332346003', display: 'Erythromycin 20 mg/mL cutaneous solution' }],
    reason: 'The XML explicitly excludes topical erythromycin solution. Exclude the UK 2% solution VMP and its AMPs, and retain the international cutaneous solution exactly.',
    source: 'UK dm+d VMP 41739411000001106 (Erythromycin 2% solution) and AMP descendants; SNOMED 332346003; XML exception 540241000033110 (Erythromycin Topical solution)' },
  ...[
    { emisCode: '577641000033113', emisDisplay: 'Fluticasone Propionate Aqueous nasal spray 0.05 % (150 dose spray)' },
    { emisCode: '4164541000033114', emisDisplay: 'Fluticasone Propionate Aqueous nasal spray 50 micrograms/dose, 60 doses' },
  ].map(xml => ({ version: 3, ...xml, mode: 'dmd_family' as const,
    targets: [{ code: '39110511000001107', display: 'Fluticasone propionate 50micrograms/dose nasal spray' }],
    reason: 'The XML excludes generic fluticasone nasal spray. The legacy substance or pack target misses the nasal VMP and its AMPs; exclude that formulation family and retain inhaled products.',
    source: `UK dm+d VMP 39110511000001107 (Fluticasone propionate 50micrograms/dose nasal spray) and AMP descendants; XML exception ${xml.emisCode} (${xml.emisDisplay})` })),
  ...[
    { emisCode: '4158741000033117', emisDisplay: 'Beclometasone Aqueous nasal spray 50 micrograms/dose, 180 doses' },
    { emisCode: '133641000033110', emisDisplay: 'Beclomethasone Dipropionate Aqueous nasal spray 50 micrograms/dose' },
    { emisCode: '133741000033118', emisDisplay: 'Beclomethasone Dipropionate Nasal spray 50 micrograms/dose' },
  ].map(xml => ({ version: 3, ...xml, mode: 'dmd_family' as const,
    targets: [{ code: '39111911000001107', display: 'Beclometasone 50micrograms/dose nasal spray' }],
    exactTargets: [{ code: '766418004', display: 'Beclometasone dipropionate 50 microgram/actuation nasal spray' }],
    reason: 'The XML excludes generic beclometasone nasal spray. The legacy international target misses the nasal VMP and its AMPs; exclude that formulation family, retain the international nasal code exactly and retain inhaled products.',
    source: `UK dm+d VMP 39111911000001107 (Beclometasone 50micrograms/dose nasal spray) and AMP descendants; SNOMED 766418004; XML exception ${xml.emisCode} (${xml.emisDisplay})` })),
];
