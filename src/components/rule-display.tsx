'use client';

import { useEffect, useState } from 'react';
import type {
  EmisReport,
  EmisValueSet,
  ExpandedCodeSet,
  CriteriaGroup,
  ColumnGroup,
  SearchCriterion,
  ValueSetGroup,
} from '@/lib/types';
import { formatRelationship } from '@/lib/rule-format-utils';
import { buildLibraryItemReferenceSummary, buildRulesMarkdown, formatValueSetPreview, getCriterionDisplayData, getSameColumnConjunctions, formatSameColumnConjunction } from '@/lib/agent-report-utils';
import { generateValueSetFriendlyName } from '@/lib/valueset-utils';
import { BnfHint } from '@/components/bnf-hint';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  ChevronDown,
  ChevronRight,
  PlayCircle,
  FileX,
  Loader2,
  XCircle,
  ArrowUpRight,
  Link as LinkIcon,
  Copy,
  Check,
  Code2,
  TriangleAlert,
} from 'lucide-react';

interface RuleDisplayProps {
  report: EmisReport;
  expandedData: ExpandedCodeSet | null;
  isExpanding: boolean;
  totalValueSets: number;
  onExpandClick: () => void;
  onCancel: () => void;
  allReports: EmisReport[];
}

// Code system badge colours matching existing scheme
function codeSystemBadgeClass(cs?: string): string {
  switch (cs?.toUpperCase()) {
    case 'SNOMED_CONCEPT':
      return 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30';
    case 'SCT_CONST':
      return 'bg-pink-500/15 text-pink-700 dark:text-pink-300 border-pink-500/30';
    case 'SCT_DRGGRP':
      return 'bg-green-500/15 text-green-700 dark:text-green-300 border-green-500/30';
    case 'SCT_APPNAME':
      return 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30';
    case 'EMISINTERNAL':
    case 'EMIS':
      return 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30';
    case 'LIBRARY_ITEM':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30';
    default:
      return 'bg-gray-500/15 text-gray-700 dark:text-gray-300 border-gray-500/30';
  }
}

function codeSystemLabel(cs?: string): string {
  switch (cs?.toUpperCase()) {
    case 'SNOMED_CONCEPT': return 'SNOMED';
    case 'SCT_CONST': return 'SCT Const';
    case 'SCT_DRGGRP': return 'Drug Group';
    case 'SCT_APPNAME': return 'Brand';
    case 'EMISINTERNAL': return 'Internal';
    case 'EMIS': return 'EMIS';
    case 'LIBRARY_ITEM': return 'Library';
    default: return cs || 'Unknown';
  }
}

function actionBadgeClass(action: string): string {
  switch (action) {
    case 'SELECT': return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700';
    case 'REJECT': return 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300 border-red-300 dark:border-red-700';
    case 'NEXT': return 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300 border-amber-300 dark:border-amber-700';
    default: return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-300 dark:border-gray-600';
  }
}

function actionLabel(action: string): string {
  switch (action) {
    case 'SELECT': return 'Include';
    case 'REJECT': return 'Exclude';
    case 'NEXT': return 'Next rule';
    default: return action;
  }
}

function CopyableId({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70 hover:text-foreground/80 transition-colors font-mono cursor-pointer"
      title={`Copy ${label || value}`}
    >
      {label ? `${label}: ` : ''}{value}
      {copied ? <Check className="h-2.5 w-2.5 text-emerald-500" /> : <Copy className="h-2.5 w-2.5" />}
    </button>
  );
}

export default function RuleDisplay({
  report,
  expandedData,
  isExpanding,
  totalValueSets,
  onExpandClick,
  onCancel,
  allReports,
}: RuleDisplayProps) {
  const groups = report.criteriaGroups ?? [];
  const colGroups = report.columnGroups ?? [];

  // Map expanded ValueSetGroups by their ID for quick lookup
  // Also build a secondary map by code content hash, since the flat valueSets and
  // criteriaGroup valueSets may have different auto-generated IDs
  const expandedGroupMap = new Map<string, ValueSetGroup>();
  const expandedByCodesMap = new Map<string, ValueSetGroup>();
  if (expandedData?.valueSetGroups) {
    for (const g of expandedData.valueSetGroups) {
      expandedGroupMap.set(g.valueSetId, g);
      // Build content key from original codes
      if (g.originalCodes && g.originalCodes.length > 0) {
        const codeKey = g.originalCodes.map(c => c.originalCode).sort().join(',');
        expandedByCodesMap.set(codeKey, g);
      }
    }
  }

  // Lookup helper: try ID first, then fall back to content match
  function findExpanded(vs: EmisValueSet): ValueSetGroup | undefined {
    const byId = expandedGroupMap.get(vs.id);
    if (byId) return byId;
    const codeKey = vs.values.map(v => v.code).sort().join(',');
    return expandedByCodesMap.get(codeKey);
  }

  // Pre-compute friendly names for all ValueSets using the same logic as the expand API
  // Deduplicate by code content so identical ValueSets share the same name
  const friendlyNameMap = new Map<string, string>();
  const codeHashToName = new Map<string, string>();
  let vsIndex = 0;
  function collectValueSets(criteria: SearchCriterion[]) {
    for (const c of criteria) {
      for (const vs of c.valueSets) {
        if (!friendlyNameMap.has(vs.id)) {
          const codeKey = vs.values.map(v => v.code).sort().join(',');
          const existing = codeHashToName.get(codeKey);
          if (existing) {
            friendlyNameMap.set(vs.id, existing);
          } else {
            const name = generateValueSetFriendlyName(report.name, vsIndex);
            friendlyNameMap.set(vs.id, name);
            codeHashToName.set(codeKey, name);
            vsIndex++;
          }
        }
      }
      collectValueSets(c.linkedCriteria);
    }
  }
  for (const g of groups) {
    collectValueSets(g.criteria);
  }
  for (const cg of colGroups) {
    collectValueSets(cg.criteria);
  }

  const handleCopyAllRules = () => {
    const markdown = buildRulesMarkdown(report, allReports);
    navigator.clipboard.writeText(markdown);
  };

  useEffect(() => {
    const onCopyAllRules = () => {
      handleCopyAllRules();
    };
    window.addEventListener('copy-all-rules', onCopyAllRules);
    return () => {
      window.removeEventListener('copy-all-rules', onCopyAllRules);
    };
  });

  return (
    <div className="space-y-4">
      {/* Expand button */}
      {!expandedData && !isExpanding && (
        <Card className={totalValueSets === 0 ? 'bg-muted/50 border-muted' : 'bg-gradient-to-br from-primary/5 via-primary/10 to-accent/20 border-primary/30 shadow-sm'}>
          <CardContent className="pt-6">
            <div className="flex flex-col items-center text-center space-y-4">
              <div className={`h-12 w-12 rounded-full flex items-center justify-center ${totalValueSets === 0 ? 'bg-muted' : 'bg-primary/15 ring-1 ring-primary/20'}`}>
                {totalValueSets === 0 ? (
                  <FileX className="h-6 w-6 text-muted-foreground" />
                ) : (
                  <PlayCircle className="h-6 w-6 text-primary" />
                )}
              </div>
              <div>
                {totalValueSets === 0 ? (
                  <>
                    <h3 className="text-lg font-semibold mb-1">No ValueSets to expand</h3>
                    <p className="text-sm text-muted-foreground max-w-xl">
                      This report does not contain any ValueSets with expandable codes.
                    </p>
                  </>
                ) : (
                  <>
                    <h3 className="text-lg font-semibold mb-1">Ready to expand SNOMED codes</h3>
                    <p className="text-sm text-muted-foreground max-w-xl">
                      Expand {totalValueSets === 1 ? 'the' : `all ${totalValueSets}`} ValueSet{totalValueSets !== 1 ? 's' : ''} to retrieve SNOMED CT codes.
                    </p>
                  </>
                )}
              </div>
              {totalValueSets > 0 && (
                <Button onClick={onExpandClick} size="lg" className="text-base px-8 py-6 h-auto">
                  Expand all codes
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Expansion progress */}
      {isExpanding && (
        <Card className="border-primary/40 bg-primary/5 shadow-sm">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
                <div>
                  <p className="text-sm font-medium">Expanding codes...</p>
                  <p className="text-xs text-muted-foreground">
                    {expandedData?.valueSetGroups?.length ?? 0} / {totalValueSets} ValueSets
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={onCancel}>
                <XCircle className="h-4 w-4 mr-1" />
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Criteria groups (population format) */}
      {groups.length > 0 && groups.map((group, idx) => (
        <CriteriaGroupCard
          key={group.id || idx}
          group={group}
          index={idx}
          totalGroups={groups.length}
          findExpanded={findExpanded}
          friendlyNameMap={friendlyNameMap}
          allReports={allReports}
        />
      ))}

      {/* Column groups (listReport / dashboard format) */}
      {colGroups.length > 0 && colGroups.map((cg, idx) => (
        <ColumnGroupCard
          key={cg.id || idx}
          group={cg}
          findExpanded={findExpanded}
          friendlyNameMap={friendlyNameMap}
          allReports={allReports}
        />
      ))}

      {/* No structure fallback */}
      {groups.length === 0 && colGroups.length === 0 && (
        <Card className="bg-muted/30">
          <CardContent className="pt-6 text-center text-sm text-muted-foreground">
            No rule structure found for this report.
          </CardContent>
        </Card>
      )}

      {/* Raw JSON viewer */}
      {groups.length > 0 && <RawJsonViewer groups={groups} />}
      {colGroups.length > 0 && <RawJsonViewer groups={colGroups} />}
    </div>
  );
}

// --- RawJsonViewer ---

function RawJsonViewer({ groups }: { groups: unknown[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const json = JSON.stringify(groups, null, 2);
  const handleCopy = () => {
    navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="flex items-center gap-2">
        <CollapsibleTrigger asChild>
          <button className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-pointer">
            <Code2 className="h-3 w-3" />
            {isOpen ? 'Hide' : 'Show'} parsed JSON
          </button>
        </CollapsibleTrigger>
        {isOpen && (
          <button onClick={handleCopy} className="inline-flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-pointer">
            {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      <CollapsibleContent>
        <pre className="mt-2 p-3 rounded border bg-muted/30 text-[11px] font-mono overflow-auto max-h-96 text-muted-foreground">
          {json}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

// --- CriteriaGroupCard ---

function CriteriaGroupCard({
  group,
  index,
  totalGroups,
  findExpanded,
  friendlyNameMap,
  allReports,
}: {
  group: CriteriaGroup;
  index: number;
  totalGroups: number;
  findExpanded: (vs: EmisValueSet) => ValueSetGroup | undefined;
  friendlyNameMap: Map<string, string>;
  allReports: EmisReport[];
}) {
  let ruleName = `Rule ${index + 1}`;
  if (totalGroups > 1) {
    if (index === 0) ruleName += ' (Primary)';
    else ruleName += ' (Additional)';
  }

  return (
    <Card className="bg-card shadow-sm">
      {/* Header with subtle blue background */}
      <div className="flex items-center justify-between py-2.5 px-4 bg-gradient-to-r from-slate-700 to-slate-800 dark:from-slate-800 dark:to-slate-900 text-white rounded-t-xl">
        <span className="font-semibold text-sm">{ruleName}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-300">Pass:</span>
          <Badge variant="outline" className={actionBadgeClass(group.actionIfTrue)}>
            {actionLabel(group.actionIfTrue)}
          </Badge>
          <span className="text-xs text-slate-300">Fail:</span>
          <Badge variant="outline" className={actionBadgeClass(group.actionIfFalse)}>
            {actionLabel(group.actionIfFalse)}
          </Badge>
        </div>
      </div>

      {/* Rule content */}
      <CardContent className="pt-3 pb-4 px-4 space-y-1">
        {/* Population criteria refs */}
        {group.populationCriteria.length > 0 && (
          <div className="space-y-1">
            {group.populationCriteria.map((pc, pcIdx) => (
              <div key={pc.reportGuid}>
                {pcIdx > 0 && (
                  <div className="flex items-center gap-2 py-1">
                    <Badge variant="outline" className={group.memberOperator === 'OR' ? 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30 text-[10px]' : 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30 text-[10px]'}>
                      {group.memberOperator}
                    </Badge>
                    <div className="flex-1 border-t border-border/40" />
                  </div>
                )}
                <PopulationRef pc={pc} allReports={allReports} />
              </div>
            ))}
          </div>
        )}

        {/* Criteria with operator dividers between them */}
        {group.criteria.length > 0 ? (
          group.criteria.map((criterion, cIdx) => (
            <div key={criterion.id || cIdx}>
              {(cIdx > 0 || group.populationCriteria.length > 0) && (
                <div className="flex items-center gap-2 py-1">
                  <Badge variant="outline" className={group.memberOperator === 'OR' ? 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30 text-[10px]' : 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30 text-[10px]'}>
                    {group.memberOperator}
                  </Badge>
                  <div className="flex-1 border-t border-border/40" />
                </div>
              )}
              <CriterionCard
                criterion={criterion}
                index={cIdx}
                findExpanded={findExpanded}
                friendlyNameMap={friendlyNameMap}
                allReports={allReports}
                depth={0}
              />
            </div>
          ))
        ) : (
          group.populationCriteria.length === 0 && (
            group.libraryItemRefs && group.libraryItemRefs.length > 0 ? (
              <LibraryItemRefs refs={group.libraryItemRefs} allReports={allReports} />
            ) : (
              <p className="text-xs text-muted-foreground italic">No criteria in this rule.</p>
            )
          )
        )}
      </CardContent>
    </Card>
  );
}

// --- ColumnGroupCard (listReport / dashboard format) ---

function ColumnGroupCard({
  group,
  findExpanded,
  friendlyNameMap,
  allReports,
}: {
  group: ColumnGroup;
  findExpanded: (vs: EmisValueSet) => ValueSetGroup | undefined;
  friendlyNameMap: Map<string, string>;
  allReports: EmisReport[];
}) {
  const isPatientDetails = group.logicalTableName === 'PATIENTS' && group.criteria.length === 0;

  if (isPatientDetails) {
    // Compact display for Patient Details column (no criteria)
    return (
      <Card className="bg-muted/20">
        <div className="flex items-center gap-2 py-2 px-4">
          <span className="text-sm font-medium text-muted-foreground">{group.displayName}</span>
          <div className="flex flex-wrap gap-1">
            {group.listColumns.map(lc => (
              <Badge key={lc.id} variant="outline" className="bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20 text-[10px] px-1.5">
                {lc.displayName}
              </Badge>
            ))}
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="bg-card shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between py-2.5 px-4 bg-gradient-to-r from-slate-700 to-slate-800 dark:from-slate-800 dark:to-slate-900 text-white rounded-t-xl">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">{group.displayName}</span>
          <Badge variant="outline" className="bg-white/10 text-slate-100 border-white/15 text-[10px] px-1.5 shadow-sm">
            {group.logicalTableName}
          </Badge>
        </div>
        {/* Display columns */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-slate-300 mr-1">Shows:</span>
          {group.listColumns.map(lc => (
            <Badge key={lc.id} variant="outline" className="bg-cyan-400/12 text-cyan-100 border-cyan-300/25 text-[10px] px-1.5 shadow-sm">
              {lc.displayName}
            </Badge>
          ))}
        </div>
      </div>

      {/* Criteria */}
      <CardContent className="pt-3 pb-4 px-4 space-y-1">
        {group.criteria.length > 0 ? (
          group.criteria.map((criterion, cIdx) => (
            <CriterionCard
              key={criterion.id || cIdx}
              criterion={criterion}
              index={cIdx}
              findExpanded={findExpanded}
              friendlyNameMap={friendlyNameMap}
              allReports={allReports}
              depth={0}
            />
          ))
        ) : (
          <p className="text-xs text-muted-foreground italic">No criteria in this column.</p>
        )}
      </CardContent>
    </Card>
  );
}

// --- PopulationRef ---

function PopulationRef({ pc, allReports }: { pc: { id: string; reportGuid: string }; allReports: EmisReport[] }) {
  const ref = allReports.find((r) => r.xmlId === pc.reportGuid);
  return (
    <div className="flex items-center gap-2 text-sm bg-blue-500/5 border border-blue-500/20 rounded-md px-3 py-2">
      <LinkIcon className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
      <span className="text-muted-foreground">Patients included in search:</span>
      {ref ? (
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('report-selected', { detail: ref }))}
          className="inline-flex items-center text-primary hover:underline font-medium cursor-pointer"
        >
          {ref.searchName}
          <ArrowUpRight className="h-3.5 w-3.5 ml-0.5" />
        </button>
      ) : (
        <span className="text-muted-foreground">{pc.reportGuid.slice(0, 8)}...</span>
      )}
    </div>
  );
}

// --- LibraryItemRefs ---

function LibraryItemRefs({ refs, allReports }: { refs: string[]; allReports: EmisReport[] }) {
  const inferred = refs.map((ref) => buildLibraryItemReferenceSummary(ref, allReports));

  return (
    <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <TriangleAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
        <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
          {refs.length} library item reference{refs.length !== 1 ? 's' : ''} — cannot be expanded here
        </p>
      </div>
      {inferred.some((item) => item.wrapperReports.length > 0) && (
        <div className="space-y-1">
          {inferred.map((item) => (
            <div key={item.ref} className="space-y-1">
              {item.inferredName && (
                <div className="text-xs text-amber-800 dark:text-amber-200">
                  Inferred meaning: <span className="font-medium">{item.inferredName}</span>
                </div>
              )}
              {item.wrapperReports.map((wrapper) => {
                const report = allReports.find((candidate) => candidate.xmlId === wrapper.xmlId);
                if (!report) return null;
                return (
                  <div key={wrapper.xmlId} className="flex items-center gap-2 text-xs">
                    <LinkIcon className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                    <button
                      onClick={() => window.dispatchEvent(new CustomEvent('report-selected', { detail: report }))}
                      className="text-primary hover:underline font-medium cursor-pointer inline-flex items-center"
                    >
                      {wrapper.searchName}
                      <ArrowUpRight className="h-3 w-3 ml-0.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {inferred.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {inferred.map((item, i) => (
            <CopyableId key={i} label="" value={item.ref} />
          ))}
        </div>
      )}
      <p className="text-[10px] text-muted-foreground">
        The XML does not include the library item contents directly. Where possible, this view infers the likely concept from wrapper reports in the same export.
      </p>
    </div>
  );
}

// --- CriterionCard ---

function CriterionCard({
  criterion,
  index,
  findExpanded,
  friendlyNameMap,
  allReports,
  depth,
}: {
  criterion: SearchCriterion;
  index: number;
  findExpanded: (vs: EmisValueSet) => ValueSetGroup | undefined;
  friendlyNameMap: Map<string, string>;
  allReports: EmisReport[];
  depth: number;
}) {
  const [isOpen, setIsOpen] = useState(true);
  const isLinked = depth > 0;
  const { testValueSets, filters, restrictions } = getCriterionDisplayData(criterion);
  const conjunctions = getSameColumnConjunctions(criterion, friendlyNameMap);

  return (
    <div className={`rounded-md border ${isLinked ? 'border-l-2 border-l-blue-500 ml-4 bg-blue-500/5' : 'border-border bg-muted/30'}`}>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <div className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors rounded-t-md">
            {isOpen ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" />}
            <span className="text-sm font-medium truncate">{criterion.displayName || `Criterion ${index + 1}`}</span>
            <Badge variant="outline" className="bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20 text-[10px] px-1.5">
              {criterion.table}
            </Badge>
            {criterion.negation && (
              <Badge variant="outline" className="bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30 text-[10px] px-1.5">
                NOT
              </Badge>
            )}
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-3 pb-3 space-y-2">
            {/* Description removed — EMIS-authored descriptions are often misleading */}

            {/* Linked relationship description */}
            {isLinked && criterion.relationship && (
              <div className="text-xs text-blue-600 dark:text-blue-400 bg-blue-500/5 rounded px-2 py-1">
                {formatRelationship(criterion.relationship)}
              </div>
            )}

            {filters.length > 0 && (
              <div className="space-y-2">
                {filters.map((filter, filterIndex) => (
                  <div key={`filter-${filterIndex}`} className="space-y-1 rounded border border-border p-2">
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium">{filterIndex > 0 ? 'AND ' : 'Where '}</span>
                      {filter.label} {filter.value}
                    </p>
                    {filter.valueSets?.map((vs, vsIndex) => (
                      <div key={`${vs.id}-${vsIndex}`}>
                        {vsIndex > 0 && <p className="text-[10px] text-muted-foreground">OR</p>}
                        <ValueSetRow
                          vs={vs}
                          friendlyName={friendlyNameMap.get(vs.id)}
                          expanded={findExpanded?.(vs)}
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {conjunctions.map((warning) => (
              <p key={warning.column} className="text-xs text-amber-700 dark:text-amber-300">{formatSameColumnConjunction(warning)}</p>
            ))}

            {/* Restrictions (record selection) */}
            {restrictions.length > 0 && (
              <div className="space-y-1">
                <div className="flex flex-wrap gap-1.5 items-center">
                  {restrictions.map((c, i) => (
                    <span key={`r-${i}`} className="contents">
                      {i > 0 && (
                        <span className="text-[10px] text-muted-foreground font-medium">AND</span>
                      )}
                      <Badge variant="outline" className="bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/20 text-xs">
                        {c.label ? `${c.label} ${c.value}` : c.value}
                      </Badge>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Restriction test sets: check the kept record's code, not code lists */}
            {testValueSets.length > 0 && (
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                  Restriction test sets, applied after record selection
                </p>
                {testValueSets.map((vs, vsIdx) => (
                  <ValueSetRow
                    key={vs.id || `test-${vsIdx}`}
                    vs={vs}
                    friendlyName={friendlyNameMap.get(vs.id)}
                    expanded={findExpanded?.(vs)}
                  />
                ))}
              </div>
            )}

            {(criterion.baseCriteriaGroups ?? []).map((group, groupIndex) => (
              <div key={groupIndex} className="space-y-2 mt-2 rounded border border-border p-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Requires nested group {groupIndex + 1}: {group.memberOperator === 'OR' ? 'ANY (OR)' : 'ALL (AND)'} of the following
                </p>
                {group.criteria.map((nested, nestedIndex) => (
                  <div key={`${nested.id}-${nestedIndex}`}>
                    {nestedIndex > 0 && <p className="text-xs font-medium text-muted-foreground">{group.memberOperator}</p>}
                    <CriterionCard
                      criterion={nested}
                      index={nestedIndex}
                      findExpanded={findExpanded}
                      friendlyNameMap={friendlyNameMap}
                      allReports={allReports}
                      depth={depth + 1}
                    />
                  </div>
                ))}
              </div>
            ))}

            {/* Linked criteria */}
            {criterion.linkedCriteria.length > 0 && (
              <div className="space-y-2 mt-2">
                <p className="text-xs font-medium text-muted-foreground">Linked criteria:</p>
                {criterion.linkedCriteria.map((lc, lcIdx) => (
                  <CriterionCard
                    key={lc.id || lcIdx}
                    criterion={lc}
                    index={lcIdx}
                    findExpanded={findExpanded}
                    friendlyNameMap={friendlyNameMap}
                    allReports={allReports}
                    depth={depth + 1}
                  />
                ))}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// --- ValueSetRow ---

function ValueSetRow({ vs, friendlyName, expanded }: { vs: EmisValueSet; friendlyName?: string; expanded?: ValueSetGroup }) {
  const [showCodes, setShowCodes] = useState(false);
  const codeCount = vs.values.length;
  const outputCount = expanded?.concepts?.length ?? 0;
  const failedCount = expanded?.failedCodes?.length ?? 0;

  // All display names for the code list
  const displayNames = vs.values
    .map((v) => v.displayName)
    .filter(Boolean);

  // Check if this is a refset-only ValueSet (all values are refsets with no display names)
  const isRefsetOnly = displayNames.length === 0 && vs.values.length > 0 && vs.values.every(v => v.isRefset);

  // First display name for BNF hint
  const firstDisplayName = displayNames[0] || '';

  return (
    <div className="rounded border border-border/60 px-2 py-1.5 bg-background/80">
      {/* Header row */}
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {/* Truncated description (first 3 names) */}
          <div className="text-xs leading-relaxed">
            {displayNames.length > 0 ? (
              <span className="text-foreground/80">
                {displayNames.slice(0, 3).join(', ')}
                {displayNames.length > 3 && (
                  <span className="text-muted-foreground"> +{displayNames.length - 3} more</span>
                )}
              </span>
            ) : isRefsetOnly ? (
              <span className="text-foreground/80">
                Refset{vs.values.length > 1 ? 's' : ''}: {vs.values.map(v => v.code).join(', ')}
                {vs.description && <span className="text-muted-foreground"> ({vs.description})</span>}
              </span>
            ) : (
              <span className="text-muted-foreground italic">
                {vs.description || 'No display names'}
              </span>
            )}
          </div>
          {/* Metadata line: code count, code system, cluster ID, exceptions */}
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-[11px] text-muted-foreground">
              {codeCount} code{codeCount !== 1 ? 's' : ''}
            </span>
            <Badge variant="outline" className={`${codeSystemBadgeClass(vs.codeSystem)} text-[10px] px-1.5`}>
              {codeSystemLabel(vs.codeSystem)}
            </Badge>
            {vs.description && (
              <CopyableId label="Cluster" value={vs.description} />
            )}
            {vs.exceptions.length > 0 && (
              <span className="text-[11px] text-red-600 dark:text-red-400">
                {vs.exceptions.length} excluded
              </span>
            )}
          </div>
        </div>

        {/* Right side: friendly name, expanded counts, code system badge, show codes */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {friendlyName && (
            <CopyableId label="" value={friendlyName} />
          )}
          {expanded && (
            <>
              <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20 text-[10px] px-1.5">
                {outputCount} SNOMED
              </Badge>
              {failedCount > 0 && (
                <Badge variant="outline" className="bg-orange-500/10 text-orange-700 dark:text-orange-300 border-orange-500/20 text-[10px] px-1.5">
                  {failedCount} failed
                </Badge>
              )}
            </>
          )}
          {(codeCount > 0 || expanded) && (
            <button
              onClick={() => setShowCodes(!showCodes)}
              className="text-[11px] text-primary hover:underline whitespace-nowrap"
            >
              {showCodes ? 'Hide codes' : 'Show codes'}
            </button>
          )}
        </div>
      </div>

      {showCodes && (
        <div className="mt-2 space-y-2">
          {/* Input codes with translations */}
          <div className="text-xs text-muted-foreground">
            <p className="font-medium mb-1">Input codes:</p>
            <div className="grid grid-cols-1 gap-0.5">
              {expanded?.originalCodes ? (
                expanded.originalCodes.map((oc, i) => (
                  <div key={i} className="flex items-center gap-2 font-mono text-[11px]">
                    <span className="text-foreground/80">{oc.originalCode}</span>
                    {oc.displayName && <span className="text-muted-foreground">— {oc.displayName}</span>}
                    {oc.includeChildren && <span className="text-blue-600 dark:text-blue-400 text-[9px]">+children</span>}
                    {oc.isRefset && <span className="text-purple-600 dark:text-purple-400 text-[9px]">refset</span>}
                    {oc.translatedTo && (
                      <span className="text-emerald-600 dark:text-emerald-400 text-[9px]">
                        &rarr; {oc.translatedTo}{oc.translatedToDisplay ? ` (${oc.translatedToDisplay})` : ''}
                      </span>
                    )}
                  </div>
                ))
              ) : (
                vs.values.map((v, i) => (
                  <div key={i} className="flex items-center gap-2 font-mono text-[11px]">
                    <span className="text-foreground/80">{v.code}</span>
                    {v.displayName && <span className="text-muted-foreground">— {v.displayName}</span>}
                    {v.includeChildren && <span className="text-blue-600 dark:text-blue-400 text-[9px]">+children</span>}
                    {v.isRefset && <span className="text-purple-600 dark:text-purple-400 text-[9px]">refset</span>}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Failed codes */}
          {expanded?.failedCodes && expanded.failedCodes.length > 0 && (
            <div className="text-xs border-t border-orange-500/20 pt-1">
              <p className="font-medium mb-1 text-orange-700 dark:text-orange-300">
                Failed to map ({expanded.failedCodes.length}):
              </p>
              <div className="grid grid-cols-1 gap-0.5">
                {expanded.failedCodes.map((fc, i) => (
                  <div key={i} className="flex items-center gap-2 font-mono text-[11px]">
                    <span className="text-foreground/80">{fc.originalCode}</span>
                    {fc.displayName && <span className="text-muted-foreground">— {fc.displayName}</span>}
                    <span className="text-red-600 dark:text-red-400 text-[9px]">{fc.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* BNF hint for failed SCT_DRGGRP codes */}
          {vs.codeSystem === 'SCT_DRGGRP' && failedCount > 0 && firstDisplayName && (
            <BnfHint displayName={firstDisplayName} codeSystem={vs.codeSystem} />
          )}

          {/* SNOMED output codes */}
          {expanded && outputCount > 0 && (
            <div className="text-xs border-t border-emerald-500/20 pt-1">
              <p className="font-medium mb-1 text-emerald-700 dark:text-emerald-300">
                SNOMED output ({outputCount}):
              </p>
              <div className="grid grid-cols-1 gap-0.5">
                {expanded.concepts.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 font-mono text-[11px]">
                    <span className="text-foreground/80">{c.code}</span>
                    <span className="text-muted-foreground">— {c.display}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Expansion error */}
          {expanded?.expansionError && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-500/5 rounded px-2 py-1">
              {expanded.expansionError}
            </div>
          )}

          {/* Clinical code ID */}
          <CopyableId label="Clinical Code" value={vs.id} />
        </div>
      )}
    </div>
  );
}

