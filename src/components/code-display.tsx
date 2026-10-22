'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Copy, Check, Download, ChevronDown, ChevronRight, CheckCircle2, XCircle, Loader2, ChevronUp } from 'lucide-react';
import { ExpandedCodeSet, EmisReport } from '@/lib/types';
import NormalisedDataView from './normalised-data-view';
import { BnfHint } from './bnf-hint';

interface CodeDisplayProps {
  expandedCodes: ExpandedCodeSet;
  report?: EmisReport;
  isExpanding?: boolean;
  totalValueSets?: number;
  onCancel?: () => void;
  showBnfHints?: boolean; // Only show BNF hints in explore mode
}

const getCodeSystemBadgeClass = (codeSystem?: string): string => {
  if (!codeSystem) {
    return 'text-xs bg-gray-50 text-gray-700 border-gray-200';
  }

  const system = codeSystem.toUpperCase();

  // SNOMED_CONCEPT (blue)
  if (system === 'SNOMED_CONCEPT') {
    return 'text-xs bg-blue-50 text-blue-700 border-blue-200';
  }
  // SCT_CONST (pink)
  if (system === 'SCT_CONST') {
    return 'text-xs bg-pink-50 text-pink-700 border-pink-200';
  }
  // SCT_DRGGRP (green)
  if (system === 'SCT_DRGGRP') {
    return 'text-xs bg-green-50 text-green-700 border-green-200';
  }
  // EMISINTERNAL (purple)
  if (system === 'EMISINTERNAL' || system === 'EMIS') {
    return 'text-xs bg-purple-50 text-purple-700 border-purple-200';
  }

  return 'text-xs bg-gray-50 text-gray-700 border-gray-200';
};

export default function CodeDisplay({ expandedCodes, report, isExpanding, totalValueSets, onCancel, showBnfHints = false }: CodeDisplayProps) {
  const [copiedButton, setCopiedButton] = useState<number | 'all' | null>(null);
  const [expandedValueSets, setExpandedValueSets] = useState<Set<number>>(new Set());
  const [copiedItem, setCopiedItem] = useState<string | null>(null);
  const [expandedSqlBlocks, setExpandedSqlBlocks] = useState<Set<number>>(new Set());
  const [expandedEclBlocks, setExpandedEclBlocks] = useState<Set<number>>(new Set());
  
  const SQL_TRUNCATE_LENGTH = 500; // Characters to show before truncation
  const ECL_TRUNCATE_LENGTH = 500; // Characters to show before truncation

  const handleCopy = async (codesText: string, buttonId: number | 'all') => {
    await navigator.clipboard.writeText(codesText);
    setCopiedButton(buttonId);
    setTimeout(() => setCopiedButton(null), 2000);
  };

  const handleCopyItem = async (text: string, itemId: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedItem(itemId);
    setTimeout(() => setCopiedItem(null), 2000);
  };

  const toggleValueSet = (index: number) => {
    const newExpanded = new Set(expandedValueSets);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedValueSets(newExpanded);
  };

  const toggleSqlBlock = (index: number) => {
    const newExpanded = new Set(expandedSqlBlocks);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedSqlBlocks(newExpanded);
  };

  const toggleEclBlock = (index: number) => {
    const newExpanded = new Set(expandedEclBlocks);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedEclBlocks(newExpanded);
  };

  const handleDownloadCsv = (group: any, type: 'xml' | 'output' | 'summary') => {
    const date = new Date().toISOString().split('T')[0];
    let filename: string;
    let csvContent: string;

    if (type === 'summary') {
      filename = `${expandedCodes.featureName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_summary_${date}.csv`;
      const headers = ['ValueSet Name', 'Unique Name', 'Hash', 'XML Count', 'Output Count', 'SQL'];
      const rows = expandedCodes.valueSetGroups?.map(g => [
        g.valueSetFriendlyName,
        g.valueSetUniqueName,
        g.valueSetHash,
        g.originalCodes?.length || 0,
        g.concepts.length,
        `"${g.sqlFormattedCodes.replace(/"/g, '""')}"`,
      ]) || [];
      csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    } else {
      const sanitisedName = group.valueSetFriendlyName || 'valueset';
      filename = `${sanitisedName}_${type}_${date}.csv`;

      if (type === 'xml' && group.originalCodes) {
        const headers = ['Original Code', 'Display', 'Code System', 'Include Children', 'Translated Code', 'Translated Display', 'Translation Equivalence'];
        const rows = group.originalCodes.map((oc: any) => [
          oc.originalCode,
          `"${oc.displayName.replace(/"/g, '""')}"`,
          oc.codeSystem,
          oc.includeChildren ? 'Yes' : 'No',
          oc.translatedTo || '',
          oc.translatedToDisplay ? `"${oc.translatedToDisplay.replace(/"/g, '""')}"` : '',
          oc.translationEquivalence || 'unmapped',
        ]);
        csvContent = [headers.join(','), ...rows.map((r: string[]) => r.join(','))].join('\n');
      } else {
        // Determine which codes are descendants (not in parentCodes)
        const parentCodesSet = new Set(group.parentCodes || []);

        const headers = ['SNOMED Code', 'Display', 'Source', 'Is Descendant'];
        const rows = group.concepts.map((c: any) => {
          const isDescendant = !parentCodesSet.has(c.code);
          return [
            c.code,
            `"${c.display.replace(/"/g, '""')}"`,
            'Terminology Server',
            isDescendant ? 'Yes' : 'No',
          ];
        });
        csvContent = [headers.join(','), ...rows.map((r: string[]) => r.join(','))].join('\n');
      }
    }

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Tabs defaultValue="expanded" className="space-y-4 w-full max-w-full min-w-0">
      <TabsList className="w-full sm:w-auto">
        <TabsTrigger value="expanded" className="flex-1 sm:flex-none">Expanded Codes</TabsTrigger>
        <TabsTrigger value="normalised" className="flex-1 sm:flex-none">Normalised Data</TabsTrigger>
      </TabsList>

      <TabsContent value="expanded" className="space-y-4 w-full max-w-full min-w-0">
        {/* Summary */}
        <Card className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div>
              <div className="text-sm text-muted-foreground">Total Codes</div>
              <div className="text-2xl font-bold">{expandedCodes.totalCount}</div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground">ValueSets</div>
              <div className="text-2xl font-bold">{expandedCodes.valueSetGroups?.length || 0}</div>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleDownloadCsv(null, 'summary')}
          >
            <Download className="w-4 h-4 mr-2" />
            Export Summary
          </Button>
        </div>
      </Card>

      {/* Mapping Status Summary */}
      {expandedCodes.valueSetGroups && (() => {
        const completedValueSets = expandedCodes.valueSetGroups.length;
        const totalFailedCodes = expandedCodes.valueSetGroups.reduce(
          (sum, group) => sum + (group.failedCodes?.length || 0),
          0
        );
        const failedValueSets = expandedCodes.valueSetGroups.filter(
          group => group.failedCodes && group.failedCodes.length > 0
        ).length;

        // Show progress message while expanding
        if (isExpanding) {
          return (
            <Card className="border-blue-200 bg-blue-50/50">
              <div className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <Loader2 className="w-5 h-5 text-blue-600 flex-shrink-0 animate-spin" />
                  <div className="min-w-0">
                    <p className="font-semibold text-blue-900">Expanding codes...</p>
                    <p className="text-sm text-blue-700">
                      Processing {completedValueSets} of {totalValueSets || completedValueSets} ValueSet{(totalValueSets || completedValueSets) !== 1 ? 's' : ''}
                      {totalFailedCodes > 0 && ` • ${totalFailedCodes} code${totalFailedCodes !== 1 ? 's' : ''} failed so far`}
                    </p>
                  </div>
                </div>
                {onCancel && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={onCancel}
                    className="gap-2 flex-shrink-0"
                  >
                    <XCircle className="h-4 w-4" />
                    Cancel
                  </Button>
                )}
              </div>
            </Card>
          );
        }

        // Show final status when complete
        return (
          <Card className={totalFailedCodes > 0 ? 'border-orange-200 bg-orange-50/50' : 'border-green-200 bg-green-50/50'}>
            <div className="px-4 py-3 flex items-center gap-2">
              {totalFailedCodes > 0 ? (
                <>
                  <XCircle className="w-5 h-5 text-orange-600 flex-shrink-0" />
                  <div>
                    <p className="font-semibold text-orange-900">
                      {totalFailedCodes} code{totalFailedCodes !== 1 ? 's' : ''} failed to map
                    </p>
                    <p className="text-sm text-orange-700">
                      {failedValueSets} of {completedValueSets} ValueSet{completedValueSets !== 1 ? 's' : ''} had mapping failures
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0" />
                  <div>
                    <p className="font-semibold text-green-900">All codes successfully mapped</p>
                    <p className="text-sm text-green-700">
                      {completedValueSets === 1 ? 'ValueSet' : `All ${completedValueSets} ValueSets`} expanded without errors
                    </p>
                  </div>
                </>
              )}
            </div>
          </Card>
        );
      })()}

      {/* ValueSets Table */}
      <Card className="w-full max-w-full min-w-0 overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 whitespace-nowrap"></TableHead>
              <TableHead className="w-12 whitespace-nowrap">Status</TableHead>
              <TableHead className="min-w-[200px] max-w-[400px] whitespace-nowrap">ValueSet Name</TableHead>
              <TableHead className="w-32 whitespace-nowrap">Hash</TableHead>
              <TableHead className="w-16 text-right whitespace-nowrap">XML</TableHead>
              <TableHead className="w-20 text-right whitespace-nowrap">Output</TableHead>
              <TableHead className="w-24 whitespace-nowrap">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {expandedCodes.valueSetGroups?.map((group, idx) => {
              const isExpanded = expandedValueSets.has(idx);
              const inputCount = group.originalCodes?.length || 0;
              const outputCount = group.concepts.length;

              return (
                <React.Fragment key={idx}>
                  <TableRow className="cursor-pointer hover:bg-muted/50" onClick={() => toggleValueSet(idx)}>
                    <TableCell>
                      {isExpanded ? (
                        <ChevronDown className="w-4 h-4" />
                      ) : (
                        <ChevronRight className="w-4 h-4" />
                      )}
                    </TableCell>
                    <TableCell>
                      {group.failedCodes && group.failedCodes.length > 0 ? (
                        <div title={`${group.failedCodes.length} code(s) failed to map`}>
                          <XCircle className="w-4 h-4 text-orange-600" />
                        </div>
                      ) : (
                        <div title="All codes mapped successfully">
                          <CheckCircle2 className="w-4 h-4 text-green-600" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="min-w-[200px] max-w-[400px]">
                      <div className="flex flex-col gap-1">
                        <div
                          className="group flex items-center gap-1 cursor-pointer min-w-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyItem(group.valueSetFriendlyName, `name-${idx}`);
                          }}
                          title={`${group.valueSetFriendlyName} - Click to copy`}
                        >
                          <span className="font-medium text-sm group-hover:text-primary transition-colors truncate">
                            {group.valueSetFriendlyName}
                          </span>
                          {copiedItem === `name-${idx}` ? (
                            <Check className="w-3 h-3 text-green-600 flex-shrink-0" />
                          ) : (
                            <Copy className="h-3 w-0 overflow-hidden opacity-0 group-hover:w-3 group-hover:opacity-100 transition-all text-muted-foreground flex-shrink-0" />
                          )}
                        </div>
                        <div
                          className="group cursor-pointer"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyItem(group.valueSetUniqueName, `id-${idx}`);
                          }}
                          title={`ID: ${group.valueSetUniqueName} - Click to copy`}
                        >
                          <Badge
                            variant="outline"
                            className="font-mono text-[10px] bg-purple-50 text-purple-700 border-purple-200 group-hover:bg-purple-100 transition-all inline-flex items-center gap-1 max-w-full"
                          >
                            <span className="truncate">{group.valueSetUniqueName}</span>
                            {copiedItem === `id-${idx}` ? (
                              <Check className="w-3 h-3 text-green-600 flex-shrink-0" />
                            ) : (
                              <Copy className="h-3 w-0 overflow-hidden opacity-0 group-hover:w-3 group-hover:opacity-100 transition-all flex-shrink-0" />
                            )}
                          </Badge>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="w-32">
                      <div
                        className="group flex items-center gap-1 cursor-pointer min-w-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCopyItem(group.valueSetHash, `hash-${idx}`);
                        }}
                        title={`Hash: ${group.valueSetHash} - Click to copy`}
                      >
                        <span className="font-mono text-xs text-muted-foreground truncate group-hover:text-primary transition-colors">
                          {group.valueSetHash}
                        </span>
                        {copiedItem === `hash-${idx}` ? (
                          <Check className="w-3 h-3 text-green-600 flex-shrink-0" />
                        ) : (
                          <Copy className="h-3 w-0 overflow-hidden opacity-0 group-hover:w-3 group-hover:opacity-100 transition-all text-muted-foreground flex-shrink-0" />
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">{inputCount}</TableCell>
                    <TableCell className="text-right font-medium whitespace-nowrap">{outputCount}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()} className="whitespace-nowrap">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDownloadCsv(group, 'output')}
                        className="mr-2"
                      >
                        <Download className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  </TableRow>

                  {isExpanded && (
                    <TableRow>
                      <TableCell colSpan={7} className="p-0">
                        <div className="bg-muted/30 p-4 space-y-4">
                          {/* Input Codes Table */}
                          {group.originalCodes && group.originalCodes.length > 0 && (
                            <div>
                              <div className="flex items-center justify-between mb-2">
                                <h4 className="text-sm font-semibold">XML Codes ({inputCount})</h4>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleDownloadCsv(group, 'xml')}
                                >
                                  <Download className="w-4 h-4 mr-2" />
                                  CSV
                                </Button>
                              </div>
                              <div className="border rounded-md bg-background max-h-96 overflow-y-auto">
                                <Table>
                                  <TableHeader className="sticky top-0 bg-background">
                                    <TableRow>
                                      <TableHead className="w-32 whitespace-nowrap">Code</TableHead>
                                      <TableHead className="min-w-[150px]">Display</TableHead>
                                      <TableHead className="w-28 whitespace-nowrap">System</TableHead>
                                      <TableHead className="w-20 text-center whitespace-nowrap">Is Refset</TableHead>
                                      <TableHead className="w-20 text-center whitespace-nowrap">Children</TableHead>
                                      <TableHead className="w-32 whitespace-nowrap">Translated Code</TableHead>
                                      <TableHead className="min-w-[150px]">Translated Display</TableHead>
                                      <TableHead>Translation equivalence</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {group.originalCodes.map((oc, i) => {
                                      // Check if this ValueSet has exceptions (which means some children are excluded)
                                      // If the ECL expression contains MINUS, there are exceptions
                                      const hasExceptions = group.eclExpression?.includes('MINUS') ?? false;
                                      
                                      return (
                                        <TableRow key={i}>
                                          <TableCell className="font-mono text-xs whitespace-nowrap">{oc.originalCode}</TableCell>
                                          <TableCell className="text-sm">{oc.displayName}</TableCell>
                                          <TableCell className="whitespace-nowrap">
                                            <Badge variant="outline" className={getCodeSystemBadgeClass(oc.codeSystem)}>
                                              {oc.codeSystem}
                                            </Badge>
                                          </TableCell>
                                          <TableCell className="text-center whitespace-nowrap">
                                            {oc.isRefset ? '✓' : ''}
                                          </TableCell>
                                          <TableCell className="text-center whitespace-nowrap">
                                            {oc.includeChildren && (
                                              <Badge className="text-xs">
                                                {hasExceptions ? 'Some' : 'Yes'}
                                              </Badge>
                                            )}
                                            {!oc.includeChildren && (
                                              <Badge variant="outline" className="text-xs">No</Badge>
                                            )}
                                          </TableCell>
                                        <TableCell className="font-mono text-xs whitespace-nowrap">
                                          {oc.translatedTo && (
                                            <span className="text-green-600">{oc.translatedTo}</span>
                                          )}
                                        </TableCell>
                                        <TableCell className="text-sm text-muted-foreground">
                                          {oc.translatedToDisplay || ''}
                                        </TableCell>
                                        <TableCell>{oc.translationEquivalence || 'unmapped'}</TableCell>
                                      </TableRow>
                                      );
                                    })}
                                  </TableBody>
                                </Table>
                              </div>
                            </div>
                          )}

                          {/* Refsets Metadata */}
                          {group.refsets && group.refsets.length > 0 && (
                            <div>
                              <h4 className="text-sm font-semibold mb-2">Refsets ({group.refsets.length})</h4>
                              <div className="border rounded-md bg-background">
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead className="w-48">Refset Code</TableHead>
                                      <TableHead>Refset Name</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {group.refsets.map((refset, i) => (
                                      <TableRow key={i}>
                                        <TableCell className="font-mono text-xs">{refset.refsetId}</TableCell>
                                        <TableCell className="text-sm">{refset.refsetName}</TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            </div>
                          )}
                          
                          {/* Output Codes Table */}
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <h4 className="text-sm font-semibold">Output Codes ({outputCount})</h4>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDownloadCsv(group, 'output')}
                              >
                                <Download className="w-4 h-4 mr-2" />
                                CSV
                              </Button>
                            </div>
                            <div className="border rounded-md bg-background max-h-96 overflow-y-auto">
                              <Table>
                                <TableHeader className="sticky top-0 bg-background">
                                  <TableRow>
                                    <TableHead className="w-32">Code</TableHead>
                                    <TableHead>Display</TableHead>
                                    <TableHead className="w-40">Source</TableHead>
                                    <TableHead className="w-24 text-center whitespace-nowrap">Descendant</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {(() => {
                                    // Determine which codes are descendants (not in parentCodes)
                                    const parentCodesSet = new Set(group.parentCodes || []);

                                    return group.concepts.map((concept, i) => {
                                      const isDescendant = !parentCodesSet.has(concept.code);

                                      return (
                                        <TableRow key={i}>
                                          <TableCell className="font-mono text-xs">{concept.code}</TableCell>
                                          <TableCell className="text-sm">{concept.display}</TableCell>
                                          <TableCell className="whitespace-nowrap">
                                            <Badge className={`text-xs ${
                                              concept.source === 'rf2_file'
                                                ? 'bg-blue-100 text-blue-800 border-blue-200 hover:!bg-blue-100'
                                                : 'bg-green-100 text-green-800 border-green-200 hover:!bg-green-100'
                                            }`}>
                                              {concept.source === 'rf2_file' ? 'RF2' : 'terminology_server'}
                                            </Badge>
                                          </TableCell>
                                          <TableCell className="text-center whitespace-nowrap">
                                            {isDescendant && <Badge variant="secondary" className="text-xs">Yes</Badge>}
                                          </TableCell>
                                        </TableRow>
                                      );
                                    });
                                  })()}
                                </TableBody>
                              </Table>
                            </div>
                          </div>

                          {/* ECL Expression - only show if there are output codes */}
                          {group.eclExpression && outputCount > 0 && (
                            <div>
                              <div className="flex items-center justify-between mb-2">
                                <h4 className="text-sm font-semibold">ECL Expression</h4>
                                <div className="flex items-center gap-2">
                                  {group.eclExpression.length > ECL_TRUNCATE_LENGTH && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => toggleEclBlock(idx)}
                                      className="h-8"
                                    >
                                      {expandedEclBlocks.has(idx) ? (
                                        <>
                                          <ChevronUp className="w-4 h-4 mr-1" />
                                          Collapse
                                        </>
                                      ) : (
                                        <>
                                          <ChevronDown className="w-4 h-4 mr-1" />
                                          Expand
                                        </>
                                      )}
                                    </Button>
                                  )}
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleCopyItem(group.eclExpression!, `ecl-expanded-${idx}`)}
                                  >
                                    {copiedItem === `ecl-expanded-${idx}` ? (
                                      <>
                                        <Check className="w-4 h-4 mr-2" />
                                        Copied!
                                      </>
                                    ) : (
                                      <>
                                        <Copy className="w-4 h-4 mr-2" />
                                        Copy ECL
                                      </>
                                    )}
                                  </Button>
                                </div>
                              </div>
                              <div className="border rounded-md bg-muted/50 p-3">
                                <code className="text-xs font-mono text-muted-foreground break-all whitespace-pre-wrap">
                                  {group.eclExpression.length > ECL_TRUNCATE_LENGTH && !expandedEclBlocks.has(idx) ? (
                                    <>
                                      {group.eclExpression.substring(0, ECL_TRUNCATE_LENGTH)}
                                      <span className="text-muted-foreground/70">... (truncated, {group.eclExpression.length - ECL_TRUNCATE_LENGTH} more characters)</span>
                                    </>
                                  ) : (
                                    group.eclExpression
                                  )}
                                </code>
                              </div>
                            </div>
                          )}

                          {/* SQL Format Preview - only show if there are output codes */}
                          {outputCount > 0 && (
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <h4 className="text-sm font-semibold">SQL IN Clause Format</h4>
                              <div className="flex items-center gap-2">
                                {group.sqlFormattedCodes.length > SQL_TRUNCATE_LENGTH && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => toggleSqlBlock(idx)}
                                    className="h-8"
                                  >
                                    {expandedSqlBlocks.has(idx) ? (
                                      <>
                                        <ChevronUp className="w-4 h-4 mr-1" />
                                        Collapse
                                      </>
                                    ) : (
                                      <>
                                        <ChevronDown className="w-4 h-4 mr-1" />
                                        Expand
                                      </>
                                    )}
                                  </Button>
                                )}
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleCopy(group.sqlFormattedCodes, idx)}
                                >
                                  {copiedButton === idx ? (
                                    <>
                                      <Check className="w-4 h-4 mr-2" />
                                      Copied!
                                    </>
                                  ) : (
                                    <>
                                      <Copy className="w-4 h-4 mr-2" />
                                      Copy for SQL
                                    </>
                                  )}
                                </Button>
                              </div>
                            </div>
                            <div className="border rounded-md bg-muted/50 p-3">
                              <code className="text-xs font-mono text-muted-foreground break-all">
                                {group.sqlFormattedCodes.length > SQL_TRUNCATE_LENGTH && !expandedSqlBlocks.has(idx) ? (
                                  <>
                                    {group.sqlFormattedCodes.substring(0, SQL_TRUNCATE_LENGTH)}
                                    <span className="text-muted-foreground/70">... (truncated, {group.sqlFormattedCodes.length - SQL_TRUNCATE_LENGTH} more characters)</span>
                                  </>
                                ) : (
                                  group.sqlFormattedCodes
                                )}
                              </code>
                            </div>
                          </div>
                          )}

                          {/* Failed Codes Table */}
                          {group.failedCodes && group.failedCodes.length > 0 && (
                            <div>
                              <div className="flex items-center justify-between mb-2">
                                <h4 className="text-sm font-semibold text-orange-700">Failed Codes ({group.failedCodes.length})</h4>
                              </div>
                              <div className="border border-orange-200 rounded-md bg-orange-50/50 max-h-96 overflow-y-auto">
                                <Table>
                                  <TableHeader className="sticky top-0 bg-orange-50">
                                    <TableRow>
                                      <TableHead className="w-32">Code</TableHead>
                                      <TableHead>Display</TableHead>
                                      <TableHead className="w-32">System</TableHead>
                                      <TableHead>Reason</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {group.failedCodes.map((failed, i) => (
                                      <TableRow key={i}>
                                        <TableCell className="font-mono text-xs">{failed.originalCode}</TableCell>
                                        <TableCell className="text-sm">
                                          <div>
                                            {failed.displayName}
                                            {showBnfHints && (
                                              <BnfHint displayName={failed.displayName} codeSystem={failed.codeSystem} />
                                            )}
                                          </div>
                                        </TableCell>
                                        <TableCell>
                                          <Badge variant="outline" className={getCodeSystemBadgeClass(failed.codeSystem)}>
                                            {failed.codeSystem}
                                          </Badge>
                                        </TableCell>
                                        <TableCell>
                                          <span className="text-xs text-destructive">
                                            {failed.reason}
                                          </span>
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              );
            })}
          </TableBody>
          </Table>
        </div>
      </Card>
      </TabsContent>

      <TabsContent value="normalised" className="w-full max-w-full min-w-0">
        {report ? (
          <NormalisedDataView
            report={report}
            expandedCodes={expandedCodes}
          />
        ) : (
          <Card className="p-6">
            <p className="text-sm text-muted-foreground text-center">
              Report information is required to display normalised data view.
            </p>
          </Card>
        )}
      </TabsContent>
    </Tabs>
  );
}
