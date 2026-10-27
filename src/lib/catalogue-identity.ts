import { NormalizedTables } from './batch-assembly';
import { generateValueSetId } from './valueset-utils';

/** Carry loaded identities forward before any extractor output is written. */
export function preserveCatalogueIdentities(tables: NormalizedTables, loaded: Pick<NormalizedTables,
  'reports' | 'valuesets' | 'originalCodes' | 'exceptions'>): Map<string, string> {
  const reportIds = new Map<string, string>();
  const loadedReports = new Map(loaded.reports.map(r => [r.report_xml_id, r]));
  for (const report of tables.reports) reportIds.set(report.report_id,
    loadedReports.get(report.report_xml_id)?.report_id || report.report_id);
  const signature = (id: string, source: typeof loaded) => JSON.stringify({
    values: source.originalCodes.filter(r => r.valueset_id === id)
      .map(r => [r.original_code, !!r.include_children, !!r.is_refset]).sort(),
    exceptions: source.exceptions.filter(r => r.valueset_id === id).map(r => r.original_excluded_code).sort(),
  });
  const mapping = new Map<string, string>();
  const chosen = new Map<string, typeof tables.valuesets[number]>();
  for (const old of loaded.valuesets) {
    const candidates = tables.valuesets.filter(v => reportIds.get(v.report_id) === old.report_id && v.valueset_hash === old.valueset_hash);
    if (!candidates.length) continue;
    const exact = candidates.filter(v => signature(v.valueset_id, tables) === signature(old.valueset_id, loaded));
    const match = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (!match || mapping.has(match.valueset_id)) throw new Error(`Ambiguous loaded value-set identity ${old.valueset_id}`);
    mapping.set(match.valueset_id, old.valueset_id);
    chosen.set(match.valueset_id, old);
  }
  const next = new Map<string, number>();
  for (const old of loaded.valuesets) next.set(old.report_id, Math.max(next.get(old.report_id) || 0, old.valueset_index + 1));
  const unmatched = tables.valuesets.filter(v => !mapping.has(v.valueset_id));
  for (const value of unmatched) {
    const reportId = reportIds.get(value.report_id)!;
    const index = next.get(reportId) || 0;
    next.set(reportId, index + 1);
    const id = generateValueSetId(reportId, value.valueset_hash, index);
    mapping.set(value.valueset_id, id);
    chosen.set(value.valueset_id, { ...value, valueset_id: id, valueset_index: index,
      valueset_friendly_name: value.valueset_friendly_name.replace(/_vs\d+$/, `_vs${index + 1}`) });
  }
  for (const report of tables.reports) {
    report.report_id = reportIds.get(report.report_id)!;
    report.parent_report_id = reportIds.get(report.parent_report_id) || report.parent_report_id;
  }
  for (const value of tables.valuesets) {
    const old = chosen.get(value.valueset_id)!;
    value.valueset_id = old.valueset_id;
    value.valueset_index = old.valueset_index;
    value.valueset_friendly_name = old.valueset_friendly_name;
    value.report_id = reportIds.get(value.report_id)!;
  }
  const keys = { originalCodes: 'original_code_id', exceptions: 'exception_id', expandedConcepts: 'concept_id', failedCodes: 'failed_code_id' } as const;
  for (const [table, key] of Object.entries(keys)) for (const row of tables[table as keyof typeof keys]) {
    const oldId = row.valueset_id;
    row.valueset_id = mapping.get(oldId)!;
    row[key] = row[key].replace(oldId, row.valueset_id);
  }
  return mapping;
}
