'use client';

import React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Download } from 'lucide-react';
import { ExpandedCodeSet, EmisReport } from '@/lib/types';
import { downloadNormalizedDataZip, NormalizedTables } from '@/lib/zip-utils';
import { normalizedTableColumns } from '@/lib/normalized-table-columns';

interface NormalisedDataViewProps {
  report: EmisReport;
  expandedCodes: ExpandedCodeSet;
}

export default function NormalisedDataView({ report, expandedCodes }: NormalisedDataViewProps) {
  // Extract XML filename from rule (first segment)
  const xmlFileName = report.rule.split(' > ')[0] || 'unknown.xml';

  // Calculate row counts
  const valuesetsCount = expandedCodes.valueSetGroups?.length || 0;
  const originalCodesCount = expandedCodes.valueSetGroups?.reduce((sum, g) => sum + (g.originalCodes?.length || 0), 0) || 0;
  const expandedConceptsCount = expandedCodes.valueSetGroups?.reduce((sum, g) => sum + g.concepts.length, 0) || 0;
  const failedCodesCount = expandedCodes.valueSetGroups?.reduce((sum, g) => sum + (g.failedCodes?.length || 0), 0) || 0;
  const exceptionsCount = expandedCodes.valueSetGroups?.reduce((sum, g) => sum + (g.exceptions?.length || 0), 0) || 0;

  const handleDownloadAllTables = async () => {
    // Build reports table
    const reports = [{
      report_id: report.id,
      report_xml_id: report.xmlId,
      report_name: report.name,
      search_name: report.searchName,
      description: report.description || '',
      parent_type: report.parentType || '',
      parent_report_id: report.parentReportId || '',
      folder_path: report.rule,
      xml_file_name: xmlFileName,
      equivalence_filter_setting: expandedCodes.equivalenceFilterSetting,
      parsed_at: expandedCodes.expandedAt,
    }];

    // Build valuesets table
    const valuesets = expandedCodes.valueSetGroups?.map((group) => ({
      valueset_id: group.valueSetId,
      report_id: report.id,
      valueset_index: group.valueSetIndex,
      valueset_hash: group.valueSetHash,
      valueset_friendly_name: group.valueSetFriendlyName,
      code_system: group.originalCodes?.[0]?.codeSystem || '',
      ecl_expression: group.eclExpression || '',
      expansion_error: group.expansionError || '',
      expanded_at: expandedCodes.expandedAt,
    })) || [];

    // Build original_codes table
    const originalCodes = expandedCodes.valueSetGroups?.flatMap((group) =>
      group.originalCodes?.map((oc, idx) => ({
        original_code_id: `${group.valueSetId}-oc${idx}`,
        valueset_id: group.valueSetId,
        original_code: oc.originalCode,
        display_name: oc.displayName,
        code_system: oc.codeSystem,
        include_children: oc.includeChildren || false,
        is_refset: oc.isRefset || false,
        translated_to_snomed_code: oc.translatedTo || '',
        translated_to_display: oc.translatedToDisplay || '',
        translation_equivalence: oc.translationEquivalence || 'unmapped',
      })) || []
    ) || [];

    // Build expanded_concepts table
    const expandedConcepts = expandedCodes.valueSetGroups?.flatMap((group) => {
      const parentCodesSet = new Set(group.parentCodes || []);

      return group.concepts.map((concept, idx) => ({
        concept_id: `${group.valueSetId}-c${idx}`,
        valueset_id: group.valueSetId,
        snomed_code: concept.code,
        display: concept.display,
        source: concept.source || 'terminology_server', // Use actual source (rf2_file or terminology_server)
        exclude_children: concept.excludeChildren || false,
        is_descendant: !parentCodesSet.has(concept.code),
      }));
    }) || [];

    // Build failed_codes table
    const failedCodes = expandedCodes.valueSetGroups?.flatMap((group) =>
      group.failedCodes?.map((failed, idx) => ({
        failed_code_id: `${group.valueSetId}-failed${idx}`,
        valueset_id: group.valueSetId,
        original_code: failed.originalCode,
        display_name: failed.displayName,
        code_system: failed.codeSystem,
        reason: failed.reason,
      })) || []
    ) || [];

    // Build exceptions table (using data from API response with translation info)
    const exceptions = expandedCodes.valueSetGroups?.flatMap((group) =>
      group.exceptions?.map((exception: any, excIdx: number) => ({
        exception_id: `${group.valueSetId}-exc${excIdx}`,
        valueset_id: group.valueSetId,
        original_excluded_code: exception.originalExcludedCode,
        original_excluded_display: exception.originalExcludedDisplay || '',
        translated_to_snomed_code: exception.translatedToSnomedCode || '',
        included_in_ecl: exception.includedInEcl || false,
        translation_error: exception.translationError || '',
      })) || []
    ) || [];

    const normalizedData: NormalizedTables = {
      reports,
      valuesets,
      originalCodes,
      expandedConcepts,
      failedCodes,
      exceptions,
    };

    const filename = `${report.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_normalized_${new Date().toISOString().split('T')[0]}.zip`;
    await downloadNormalizedDataZip(normalizedData, filename);
  };

  return (
    <div className="space-y-4 w-full max-w-full min-w-0">
      {/* Download Button */}
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">Normalised Data Tables</h3>
            <p className="text-sm text-muted-foreground mt-1">
              6 tables with {valuesetsCount} ValueSets, {originalCodesCount} original codes, and {expandedConceptsCount} expanded concepts
            </p>
          </div>
          <Button onClick={handleDownloadAllTables} variant="default">
            <Download className="mr-2 h-4 w-4" />
            Download ZIP Bundle
          </Button>
        </div>
      </Card>

      {/* Reports Table */}
      <Card className="w-full max-w-full min-w-0 overflow-hidden">
        <div className="px-3 py-1.5 border-b bg-muted/30">
          <h3 className="text-xs font-semibold uppercase tracking-wide">reports (1)</h3>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">report_id</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">report_xml_id</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">report_name</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">search_name</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">description</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">parent_type</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">parent_report_id</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">folder_path</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">xml_file_name</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">equivalence_filter_setting</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">parsed_at</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">{report.id}</TableCell>
                <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">{report.xmlId}</TableCell>
                <TableCell className="h-6 px-2 py-0.5 text-xs whitespace-nowrap">{report.name}</TableCell>
                <TableCell className="h-6 px-2 py-0.5 text-xs whitespace-nowrap">{report.searchName}</TableCell>
                <TableCell className="h-6 px-2 py-0.5 text-xs whitespace-nowrap">{report.description || ''}</TableCell>
                <TableCell className="h-6 px-2 py-0.5 text-xs whitespace-nowrap">{report.parentType || ''}</TableCell>
                <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">{report.parentReportId || ''}</TableCell>
                <TableCell className="h-6 px-2 py-0.5 text-xs whitespace-nowrap">{report.rule}</TableCell>
                <TableCell className="h-6 px-2 py-0.5 text-xs whitespace-nowrap">{xmlFileName}</TableCell>
                <TableCell className="h-6 px-2 py-0.5 text-xs whitespace-nowrap">{expandedCodes.equivalenceFilterSetting}</TableCell>
                <TableCell className="h-6 px-2 py-0.5 text-xs whitespace-nowrap">{expandedCodes.expandedAt}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Valuesets Table */}
      <Card className="w-full max-w-full min-w-0 overflow-hidden">
        <div className="px-3 py-1.5 border-b bg-muted/30">
          <h3 className="text-xs font-semibold uppercase tracking-wide">valuesets ({valuesetsCount})</h3>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">valueset_id</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">report_id</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">valueset_index</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">valueset_hash</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">valueset_friendly_name</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">code_system</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap max-w-[120px]">ecl_expression</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">expansion_error</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">expanded_at</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {expandedCodes.valueSetGroups?.map((group) => (
                <TableRow key={group.valueSetId}>
                  <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">{group.valueSetId}</TableCell>
                  <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">{report.id}</TableCell>
                  <TableCell className="h-6 px-2 py-0.5 text-xs text-right whitespace-nowrap">{group.valueSetIndex}</TableCell>
                  <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">{group.valueSetHash}</TableCell>
                  <TableCell className="h-6 px-2 py-0.5 text-xs whitespace-nowrap">{group.valueSetFriendlyName}</TableCell>
                  <TableCell className="h-6 px-2 py-0.5 whitespace-nowrap">
                    {group.originalCodes?.[0]?.codeSystem && (
                      <Badge variant="outline" className="text-xs h-4 px-1 bg-blue-50 text-blue-700 border-blue-200">
                        {group.originalCodes[0].codeSystem}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap max-w-[120px]">
                    <code className="text-xs truncate block" title={group.eclExpression || ''}>
                      {group.eclExpression && group.eclExpression.length > 20 
                        ? `${group.eclExpression.substring(0, 20)}...` 
                        : (group.eclExpression || '')}
                    </code>
                  </TableCell>
                  <TableCell className="h-6 px-2 py-0.5 text-xs text-muted-foreground whitespace-nowrap">
                    {group.expansionError || ''}
                  </TableCell>
                  <TableCell className="h-6 px-2 py-0.5 text-xs whitespace-nowrap">{expandedCodes.expandedAt}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Original Codes Table */}
      <Card className="w-full max-w-full min-w-0 overflow-hidden">
        <div className="px-3 py-1.5 border-b bg-muted/30">
          <h3 className="text-xs font-semibold uppercase tracking-wide">original_codes ({originalCodesCount})</h3>
        </div>
        <div className="max-h-96 overflow-y-auto overflow-x-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">original_code_id</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">valueset_id</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">original_code</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">display_name</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">code_system</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">include_children</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">is_refset</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">translated_to_snomed_code</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">translated_to_display</TableHead>
                <TableHead>translation_equivalence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {expandedCodes.valueSetGroups?.flatMap((group) =>
                group.originalCodes?.map((oc, idx) => (
                  <TableRow key={`${group.valueSetId}-${idx}`}>
                    <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">
                      {`${group.valueSetId}-oc${idx}`}
                    </TableCell>
                    <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">{group.valueSetId}</TableCell>
                    <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">{oc.originalCode}</TableCell>
                    <TableCell className="h-6 px-2 py-0.5 text-xs whitespace-nowrap">{oc.displayName}</TableCell>
                    <TableCell className="h-6 px-2 py-0.5 whitespace-nowrap">
                      <Badge variant="outline" className="text-xs h-4 px-1 bg-blue-50 text-blue-700 border-blue-200">{oc.codeSystem}</Badge>
                    </TableCell>
                    <TableCell className="h-6 px-2 py-0.5 text-xs text-center whitespace-nowrap">
                      {oc.includeChildren ? '✓' : ''}
                    </TableCell>
                    <TableCell className="h-6 px-2 py-0.5 text-xs text-center whitespace-nowrap">
                      {oc.isRefset ? '✓' : ''}
                    </TableCell>
                    <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">
                      {oc.translatedTo || ''}
                    </TableCell>
                    <TableCell className="h-6 px-2 py-0.5 text-xs text-muted-foreground whitespace-nowrap">
                      {oc.translatedToDisplay || ''}
                    </TableCell>
                    <TableCell>{oc.translationEquivalence || 'unmapped'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Expanded Concepts Table */}
      <Card className="w-full max-w-full min-w-0 overflow-hidden">
        <div className="px-3 py-1.5 border-b bg-muted/30">
          <h3 className="text-xs font-semibold uppercase tracking-wide">expanded_concepts ({expandedConceptsCount})</h3>
        </div>
        <div className="max-h-96 overflow-y-auto overflow-x-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">concept_id</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">valueset_id</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">snomed_code</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">display</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">source</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">exclude_children</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">is_descendant</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {expandedCodes.valueSetGroups?.flatMap((group) => {
                const parentCodesSet = new Set(group.parentCodes || []);

                return group.concepts.map((concept, idx) => {
                  const isDescendant = !parentCodesSet.has(concept.code);

                  return (
                    <TableRow key={`${group.valueSetId}-${concept.code}-${idx}`}>
                      <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">
                        {`${group.valueSetId}-c${idx}`}
                      </TableCell>
                      <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">{group.valueSetId}</TableCell>
                      <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">{concept.code}</TableCell>
                      <TableCell className="h-6 px-2 py-0.5 text-xs whitespace-nowrap">{concept.display}</TableCell>
                      <TableCell className="h-6 px-2 py-0.5 whitespace-nowrap">
                        <Badge className={`text-xs h-4 px-1 ${
                          concept.source === 'rf2_file'
                            ? 'bg-blue-100 text-blue-800 border-blue-200 hover:!bg-blue-100'
                            : 'bg-green-100 text-green-800 border-green-200 hover:!bg-green-100'
                        }`}>
                          {concept.source === 'rf2_file' ? 'RF2' : 'terminology_server'}
                        </Badge>
                      </TableCell>
                      <TableCell className="h-6 px-2 py-0.5 text-xs text-center whitespace-nowrap">
                        {concept.excludeChildren ? '✓' : ''}
                      </TableCell>
                      <TableCell className="h-6 px-2 py-0.5 text-xs text-center whitespace-nowrap">
                        {isDescendant ? '✓' : ''}
                      </TableCell>
                    </TableRow>
                  );
                });
              })}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Failed Codes Table */}
      {expandedCodes.valueSetGroups?.some(g => g.failedCodes && g.failedCodes.length > 0) && (
        <Card className="border-orange-200 w-full max-w-full min-w-0 overflow-hidden">
          <div className="px-3 py-1.5 border-b bg-orange-50">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-orange-900">failed_codes ({failedCodesCount})</h3>
          </div>
          <div className="max-h-96 overflow-y-auto overflow-x-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">failed_code_id</TableHead>
                  <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">valueset_id</TableHead>
                  <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">original_code</TableHead>
                  <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">display_name</TableHead>
                  <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">code_system</TableHead>
                  <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {expandedCodes.valueSetGroups?.flatMap((group, vsIdx) =>
                  group.failedCodes?.map((failed, idx) => (
                    <TableRow key={`${group.valueSetId}-failed${idx}`} className="bg-orange-50/50">
                      <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">
                        {`${group.valueSetId}-failed${idx}`}
                      </TableCell>
                      <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">{group.valueSetId}</TableCell>
                      <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">{failed.originalCode}</TableCell>
                      <TableCell className="h-6 px-2 py-0.5 text-xs whitespace-nowrap">{failed.displayName}</TableCell>
                      <TableCell className="h-6 px-2 py-0.5 whitespace-nowrap">
                        <Badge variant="outline" className="text-xs h-4 px-1 bg-blue-50 text-blue-700 border-blue-200">{failed.codeSystem}</Badge>
                      </TableCell>
                      <TableCell className="h-6 px-2 py-0.5 whitespace-nowrap">
                        <span className="text-xs text-destructive">
                          {failed.reason}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      {/* Exceptions Table */}
      <Card className="w-full max-w-full min-w-0 overflow-hidden">
        <div className="px-3 py-1.5 border-b bg-muted/30">
          <h3 className="text-xs font-semibold uppercase tracking-wide">exceptions ({exceptionsCount})</h3>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">exception_id</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">valueset_id</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">original_excluded_code</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">original_excluded_display</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">translated_to_snomed_code</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">included_in_ecl</TableHead>
                <TableHead className="h-7 px-2 py-0.5 text-xs font-semibold whitespace-nowrap">translation_error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {expandedCodes.valueSetGroups?.flatMap((group) =>
                group.exceptions?.map((exception: any, excIdx: number) => (
                  <TableRow key={`${group.valueSetId}-exc${excIdx}`}>
                    <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">
                      {`${group.valueSetId}-exc${excIdx}`}
                    </TableCell>
                    <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">{group.valueSetId}</TableCell>
                    <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">{exception.originalExcludedCode}</TableCell>
                    <TableCell className="h-6 px-2 py-0.5 text-xs whitespace-nowrap">{exception.originalExcludedDisplay || ''}</TableCell>
                    <TableCell className="h-6 px-2 py-0.5 font-mono text-xs whitespace-nowrap">{exception.translatedToSnomedCode || ''}</TableCell>
                    <TableCell className="h-6 px-2 py-0.5 text-xs text-center whitespace-nowrap">
                      {exception.includedInEcl ? '✓' : ''}
                    </TableCell>
                    <TableCell className="h-6 px-2 py-0.5 text-xs text-muted-foreground whitespace-nowrap">{exception.translationError || ''}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}

