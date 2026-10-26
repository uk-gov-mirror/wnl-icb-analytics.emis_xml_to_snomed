# Filter fidelity fixtures

`filter-fidelity.xml` contains unchanged criteria extracted from
`NCL LTC LCS R5 updated 27112025.xml`. The report wrappers retain only the report
ID and name, with one synthetic AND group per criterion. There is no patient
data. These are rendering fixtures, not complete report populations.

- AF_61_BASE `b799351b-14fd-46ae-8098-0a920043e02d`: two drug filters on DRUGCODE,
  plus status and prescription type.
- HF PG2 `d8e067f0-73c6-4159-ae2b-25a97d421c55`: strict six-month lower bound and
  inclusive baseline upper bound on ISSUE_DATE.
- ICS_HF_21 `fbffb377-edec-48f5-af05-d811a0708899`: ACE_COD and AII_COD in one
  filter.
- DM_64_BASE `7f2ced24-41eb-4c2a-8d07-58a88e81f4fa`: Latest 999 with a NOTIN
  restriction test. The source uses 999, although the task specification calls
  this a Latest 1 example.
- Statin eligibility `eccfbddb-d698-46fd-8bcc-10e12225c4ca`: a genuine Latest 1
  restriction with a NOTIN test.
- CYPAST_HR_DTR `6411d554-3475-4506-97af-3472a237e4aa` (from the `[CYPAST_HR_DTR]`
  report; the same ID in `[rCYPAST_HR_DTR]` has no upper bound): linked window
  `GTEQ -3 MONTH` and `LT -1 DAY` relative to the parent record's date.

The other tests use synthetic combinations of these criteria or synthetic date
bounds. They do not change the extracted XML.
