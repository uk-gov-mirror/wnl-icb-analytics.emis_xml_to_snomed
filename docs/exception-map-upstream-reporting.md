# Exception mappings for upstream reporting

The LTC LCS XML exception audit found incorrect targets in the published maps.
The XML names the excluded product. A map's `equivalent` label does not establish
that its ingredient or route matches the XML.

Most reviewed incorrect targets come from the EMIS DrugCodeID map v7.1.2,
canonical URL `http://LDS.nhs/EMIS_to_Snomed/DrugCodeID/cm`:

- `139841000033114`, "Becotide Suspension 50 micrograms/ml", maps to `321129003`,
  nitrazepam oral suspension, with equivalence `equivalent`.
- `1119341000033113`, "Prednisolone Sodium Phosphate Injection 16 mg/1 ml", maps
  to `1236808007`, prednisolone eye drops, with equivalence `equivalent`.
- Other reviewed wrong targets carry `inexact`, including prednisolone injection
  to paracetamol oral solution, Preferid cream to tretinoin, Preferid ointment to
  beclometasone, Codelsol injection to necitumumab, Loderm to ethanol, and Caduet
  to empagliflozin/linagliptin. The audit queue records their codes and targets.

`1137341000033113`, "Prednesol Soluble tablets 5 mg", maps to `39720311000001101`,
paracetamol soluble tablets, in the OneLondon CodeID map v2.1.7, canonical URL
`http://LDS.nhs/EMIStoSNOMED/CodeID/cm`.

Report these examples with the source code, display, target and map version to
the map publishers. Retain the published equivalence in exports so the original
mapping decision remains visible.

Reviewers checked the applied wrong targets against the loaded June and v3
LTC LCS memberships. None removed a member. This note changes no expansion
behaviour. The separately versioned XML overrides correct the agreed preparation
exclusions; downstream replay remains a publication requirement.
