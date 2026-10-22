/** Local extraction only. This script does not upload files or write to a warehouse. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseEmisXml } from '../src/lib/xml-parser';
import { generateExpansionKey, generateValueSetHash, generateValueSetId } from '../src/lib/valueset-utils';
import { buildNormalizedTables, ExtractionInstance } from '../src/lib/batch-assembly';
import { expandValueSetClientSide } from '../src/lib/client-valueset-expander';
import { batchTranslateEmisCodes, batchResolveHistorical, expandEclPage, expandEclQuery, findPreparationCandidates, findInactivePreparationCandidates, classifyExceptionTarget, getConceptMapVersions } from '../src/lib/terminology-client';
import { detectRF2Version } from '../src/lib/rf2-version';
import { resolveExceptions } from '../src/lib/exception-resolver';
import { preserveCatalogueIdentities } from '../src/lib/catalogue-identity';
import { AppliedExceptionTarget, exceptionTranslationMismatches } from '../src/lib/exception-mismatches';
import { EXCEPTION_OVERRIDES } from '../src/lib/exception-overrides';
import { expandRefsetsFromRf2 } from '../src/lib/rf2-refset-parser';
import { convertToCSV } from '../src/lib/csv-utils';
import { normalizedTableColumns } from '../src/lib/normalized-table-columns';
import { TranslatedCode, RawValueSetExpansion } from '../src/lib/types';

async function main() {
  const [xmlPath, outputPath, filter = 'strict', legacyTargetsPath, loadedCataloguePath] = process.argv.slice(2);
  if (!xmlPath || !outputPath || !['strict', 'all'].includes(filter)) throw Error('Usage: npx tsx scripts/extract-xml.ts XML OUTPUT [strict|all] [LEGACY_TARGETS_JSON] [LOADED_CATALOGUE_JSON]');
  const legacyTargets: Record<string, string | null> | undefined = legacyTargetsPath ? JSON.parse(readFileSync(legacyTargetsPath, 'utf8')) : undefined;
  if (legacyTargetsPath && !loadedCataloguePath) throw Error('Republish requires LOADED_CATALOGUE_JSON to preserve identities');
  const out = resolve(outputPath);
  const cacheDir = join(out, 'terminology-cache');
  mkdirSync(cacheDir, { recursive: true });
  const document = await parseEmisXml(readFileSync(xmlPath, 'utf8'));
  const instances: ExtractionInstance[] = [];
  for (const report of document.reports) {
    const seen = new Set<string>();
    let vsIndex = 0;
    for (const vs of report.valueSets) {
      const expansionKey = generateExpansionKey(vs);
      if (seen.has(expansionKey)) continue;
      seen.add(expansionKey);
      instances.push({ report, vs, vsIndex: vsIndex++, hash: generateValueSetHash(vs.values.map(v => v.code)), expansionKey });
    }
  }
  writeFileSync(join(out, 'inventory.json'), JSON.stringify(instances));
  console.log(`${document.reports.length} reports, ${instances.length} value sets`);
  const nativeFetch = globalThis.fetch;
  // Cache terminology metadata only. Never persist request headers or access tokens.
  const upstreamFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === process.env.ACCESS_TOKEN_URL) {
      if (process.env.TERMINOLOGY_ACCESS_TOKEN) return Response.json({ access_token: process.env.TERMINOLOGY_ACCESS_TOKEN, expires_in: 3600 });
      return nativeFetch(input, init);
    }
    const request = { url, body: init?.body || null };
    const file = join(cacheDir, createHash('sha256').update(JSON.stringify(request)).digest('hex') + '.json');
    if (existsSync(file)) {
      const cached = JSON.parse(readFileSync(file, 'utf8'));
      return new Response(cached.body, { status: cached.status, headers: { 'Content-Type': 'application/fhir+json' } });
    }
    const response = await nativeFetch(input, init);
    if (response.ok) writeFileSync(file, JSON.stringify({ request, status: response.status, body: await response.clone().text() }));
    return response;
  };
  const classifications = new Map<string, ReturnType<typeof classifyExceptionTarget>>();
  const classify = (code: string) => {
    if (!classifications.has(code)) classifications.set(code, classifyExceptionTarget(code));
    return classifications.get(code)!;
  };
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith('/api/terminology/')) return upstreamFetch(input, init);
    const body = JSON.parse(init!.body as string);
    if (input === '/api/terminology/ecl-expand') return Response.json({ success: true, ...await expandEclPage(body.ecl, body.offset, body.count) });
    if (input === '/api/terminology/resolve-exceptions') return Response.json({ success: true,
      resolutions: await resolveExceptions(body.exceptions, body.translations, body.historical, findPreparationCandidates, findInactivePreparationCandidates, legacyTargets, { codeSystem: body.codeSystem, classifyTarget: classify, findExactTarget: expandEclQuery }) });
    if (input === '/api/terminology/resolve-historical') return Response.json({ success: true, resolutions: await batchResolveHistorical(body.conceptIds) });
    if (input === '/api/terminology/rf2-refset') {
      const found = await expandRefsetsFromRf2(body.refsetIds);
      return Response.json({ success: true, refsets: Object.fromEntries([...found].map(([code, members]) => [code, { members }])) });
    }
    throw Error(`Unexpected local endpoint ${input}`);
  };
  const codes = [...new Set(instances.flatMap(i => [...i.vs.values, ...i.vs.exceptions].map(v => v.code)))];
  const translations: Record<string, TranslatedCode | null> = {};
  const equivalences: Record<string, string> = {};
  for (let i = 0; i < codes.length; i += 200) {
    Object.assign(translations, await batchTranslateEmisCodes(codes.slice(i, i + 200), filter as 'strict' | 'all', equivalences));
    console.log(`Translated ${Math.min(i + 200, codes.length)}/${codes.length}`);
  }
  writeFileSync(join(out, 'exception_overrides.json'), JSON.stringify(EXCEPTION_OVERRIDES, null, 2));
  writeFileSync(join(out, 'translations.json'), JSON.stringify({ translations, equivalences }, null, 2));
  const targets = [...new Set([...Object.values(translations).flatMap(t => t ? [t.code] : []),
    ...instances.filter(i => i.vs.codeSystem === 'SNOMED_CONCEPT').flatMap(i => i.vs.values.map(v => v.code))])];
  const historical: Record<string, string> = {};
  for (let i = 0; i < targets.length; i += 200) {
    const resolutions = await batchResolveHistorical(targets.slice(i, i + 200));
    for (const [code, resolution] of Object.entries(resolutions)) if (resolution.currentConceptId !== code) historical[code] = resolution.currentConceptId;
  }
  writeFileSync(join(out, 'historical.json'), JSON.stringify(historical, null, 2));
  const expanded = new Map<string, RawValueSetExpansion>();
  const failed = new Map<string, string>();
  const unique = [...new Map(instances.map(i => [i.expansionKey!, i])).values()];
  let index = 0;
  for (const instance of unique) {
    const key = instance.expansionKey!;
    try {
      const raw = await expandValueSetClientSide(instance.vs, translations, historical);
      expanded.set(key, raw);
      if (raw.expansionError) failed.set(key, raw.expansionError);
    } catch (error) { failed.set(key, error instanceof Error ? error.message : String(error)); }
    console.log(`Expanded ${++index}/${unique.length}; ${failed.size} quarantined/failed`);
  }
  const tables = buildNormalizedTables(document.reports, instances, expanded, failed, translations, historical, filter as 'strict' | 'all', equivalences);
  const identities = loadedCataloguePath ? preserveCatalogueIdentities(tables, JSON.parse(readFileSync(loadedCataloguePath, 'utf8'))) : new Map<string, string>();
  writeFileSync(join(out, 'identity_mapping.json'), JSON.stringify(Object.fromEntries(identities), null, 2));
  for (const [table, columns] of Object.entries(normalizedTableColumns)) {
    const name = table.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
    writeFileSync(join(out, `${name}.csv`), convertToCSV(tables[table as keyof typeof tables], columns.map(c => c.key)));
  }
  writeFileSync(join(out, 'tables.json'), JSON.stringify(tables));
  writeFileSync(join(out, 'expansions.json'), JSON.stringify(Object.fromEntries(expanded)));
  const audit = instances.flatMap(i =>
    (expanded.get(i.expansionKey!)?.exceptionResolutions || []).map(r => ({
      valueset_id: identities.get(generateValueSetId(i.report.id, i.hash, i.vsIndex)) || generateValueSetId(i.report.id, i.hash, i.vsIndex),
      original_display: i.vs.exceptions.find(e => e.code === r.originalCode)?.displayName || '', ...r,
    })));
  writeFileSync(join(out, 'exception_resolution_audit.json'), JSON.stringify(audit, null, 2));
  const appliedTargets: AppliedExceptionTarget[] = audit.flatMap(r => [
    { originalCode: r.originalCode, code: r.code, display: r.display, valuesetId: r.valueset_id, includeDescendants: r.includeDescendants },
    ...(r.additionalCodes || []).map(code => ({ originalCode: r.originalCode, code, valuesetId: r.valueset_id, includeDescendants: r.includeDescendants })),
    ...(r.additionalDescendantCodes || []).map(code => ({ originalCode: r.originalCode, code, valuesetId: r.valueset_id, includeDescendants: true })),
    ...(r.additionalExactCodes || []).map(code => ({ originalCode: r.originalCode, code, valuesetId: r.valueset_id, includeDescendants: false })),
  ]);
  const displays = new Map(Object.values(translations).flatMap(t => t?.display ? [[t.code, t.display] as const] : []));
  const missingDisplays = [...new Set(appliedTargets.filter(t => t.code && !t.display && !displays.has(t.code)).map(t => t.code!))];
  for (let i = 0; i < missingDisplays.length; i += 50) {
    for (const target of await expandEclQuery(missingDisplays.slice(i, i + 50).join(' OR '))) displays.set(target.code, target.display);
  }
  for (const target of appliedTargets) if (target.code && !target.display) target.display = displays.get(target.code);
  writeFileSync(join(out, 'exception_translation_mismatches.json'), JSON.stringify(
    exceptionTranslationMismatches(instances.flatMap(i => i.vs.exceptions), translations, appliedTargets), null, 2));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ xml: resolve(xmlPath), xmlSha256: createHash('sha256').update(readFileSync(xmlPath)).digest('hex'),
    loadedCatalogueSha256: loadedCataloguePath ? createHash('sha256').update(readFileSync(loadedCataloguePath)).digest('hex') : null,
    exceptionOverridesSha256: createHash('sha256').update(JSON.stringify(EXCEPTION_OVERRIDES)).digest('hex'),
    generatedAt: new Date().toISOString(), filter,
    legacyTargetsSha256: legacyTargetsPath ? createHash('sha256').update(readFileSync(legacyTargetsPath)).digest('hex') : null, conceptMaps: getConceptMapVersions(), rf2: detectRF2Version(),
    counts: Object.fromEntries(Object.entries(tables).map(([key, rows]) => [key, rows.length])),
    quarantined: tables.valuesets.filter(v => v.expansion_error), equivalenceCounts: Object.fromEntries([...new Set(Object.values(equivalences))]
      .map(e => [e, Object.values(equivalences).filter(x => x === e).length])) }, null, 2));
  console.log('Extraction complete. Review manifest.json before any load.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
