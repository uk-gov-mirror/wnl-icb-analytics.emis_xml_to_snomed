'use client';

import { useState, useEffect, useRef } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { useSettings } from '@/contexts/SettingsContext';
import { EmisReport } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Package, Download, FileText, X, Loader2, CheckCircle2, AlertCircle, XCircle, Database, RefreshCw } from 'lucide-react';
import { loadParsedXmlData } from '@/lib/storage';
import { ExtractionFileList } from '@/components/extraction-file-list';
import { ExtractionDataModel } from '@/components/extraction-data-model';
import { buildNormalizedTables, ExtractionInstance, NormalizedTables } from '@/lib/batch-assembly';
import { TranslatedCode, RawValueSetExpansion } from '@/lib/types';
import { generateValueSetHash, generateExpansionKey, slugifyFileName } from '@/lib/valueset-utils';
import { buildImplementationGuideMarkdown } from '@/lib/agent-report-utils';
import { formatTime, formatTimeNatural } from '@/lib/time-utils';
import { convertToCSV } from '@/lib/csv-utils';
import { ExtractionDataViewer } from '@/components/extraction-data-viewer';
import { fetchApi, CancelledError, coerceErrorMessage } from '@/lib/api-client';
import { expandValueSetClientSide } from '@/lib/client-valueset-expander';

interface ProcessingStatus {
  currentReport: number;
  totalReports: number;
  reportName: string;
  currentValueSet: number;
  totalValueSets: number;
  message: string;
}

/** State carried across expansion passes so failed ValueSets can be retried */
interface ExtractionContext {
  instances: ExtractionInstance[];
  hashGroups: Map<string, ExtractionInstance[]>;
  expandedByHash: Map<string, RawValueSetExpansion>;
  failedByHash: Map<string, string>;
  translations: Record<string, TranslatedCode | null>;
  historical: Record<string, string>;
  equivalences: Record<string, string>;
  selectedReports: EmisReport[];
  totalInstanceCount: number;
  totalReports: number;
}

/** ValueSets expanded concurrently; each issues its own rate-limited calls */
const EXPANSION_CONCURRENCY = 3;

function getErrorSuggestions(message: string): string[] {
  const msg = message.toLowerCase();
  if (msg.includes('timeout') || msg.includes('408') || msg.includes('504')) {
    return [
      'The terminology server may be overloaded - wait a few minutes and try again',
      'Try selecting fewer reports to process at once',
      'Large ValueSets with many codes take longer to expand',
    ];
  }
  if (msg.includes('rate limit') || msg.includes('429')) {
    return [
      'The server has temporarily blocked requests - wait 1-2 minutes',
      'Processing will resume automatically if you try again',
    ];
  }
  if (msg.includes('server error') || msg.includes('500') || msg.includes('502') || msg.includes('503')) {
    return [
      'The terminology server is experiencing issues',
      'Try again in a few minutes',
      'If the problem persists, check server status',
    ];
  }
  if (msg.includes('network') || msg.includes('connect')) {
    return [
      'Check your internet connection',
      'The terminology server may be unreachable',
      'Try refreshing the page and starting again',
    ];
  }
  if (msg.includes('unexpected') || msg.includes('non-json') || msg.includes('platform error')) {
    return [
      'The server returned an invalid response',
      'This may indicate server maintenance or a configuration issue',
      'Try again in a few minutes',
    ];
  }
  return [];
}

export default function BatchExtractor() {
  const { selectedReportIds, toggleReportSelection, setIsExtracting: setContextIsExtracting } = useAppMode();
  const { equivalenceFilter } = useSettings();
  const [reports, setReports] = useState<EmisReport[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const cancellationRef = useRef(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<'idle' | 'processing' | 'completed' | 'error'>('idle');
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus | null>(null);
  const [extractedData, setExtractedData] = useState<NormalizedTables | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [remainingTime, setRemainingTime] = useState<number | null>(null);
  const [totalTime, setTotalTime] = useState<number | null>(null);
  const [isCheckingXml, setIsCheckingXml] = useState(true);
  const [isDataViewerOpen, setIsDataViewerOpen] = useState(false);
  const [failedCount, setFailedCount] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const processingStatusRef = useRef<ProcessingStatus | null>(null);
  const selectedReportsRef = useRef<EmisReport[]>([]);
  const extractionCtxRef = useRef<ExtractionContext | null>(null);

  // Load existing parsed data on mount
  useEffect(() => {
    loadParsedXmlData()
      .then((minimalData) => {
        if (minimalData && minimalData.reports) {
          setReports(minimalData.reports);
          setIsCheckingXml(false);
        } else {
          setIsCheckingXml(false);
        }
      })
      .catch((error) => {
        console.error('Failed to load stored data:', error);
        setReports([]);
        setIsCheckingXml(false);
      });
  }, []);

  useEffect(() => {
    const handleXmlParsed = (event: Event) => {
      const customEvent = event as CustomEvent;
      const parsedData = customEvent.detail;
      setReports(parsedData.reports || []);
    };

    const handleXmlCleared = () => {
      setReports([]);
      setStatus('idle');
      setProgress(0);
    };

    window.addEventListener('xml-parsed', handleXmlParsed);
    window.addEventListener('xml-cleared', handleXmlCleared);

    return () => {
      window.removeEventListener('xml-parsed', handleXmlParsed);
      window.removeEventListener('xml-cleared', handleXmlCleared);
    };
  }, []);

  const selectedReports = reports
    .filter((r) => selectedReportIds.has(r.id))
    .sort((a, b) => a.searchName.localeCompare(b.searchName));
  const totalValueSets = selectedReports.reduce((sum, r) => sum + r.valueSets.length, 0);

  // Reset status when selected reports change (allows new extraction)
  useEffect(() => {
    if (status === 'completed' && selectedReports.length > 0) {
      // Check if the selected reports have changed from what was extracted
      const currentReportIds = new Set(selectedReports.map(r => r.id));
      const extractedReportIds = extractedData?.reports.map(r => r.report_id) || [];
      const extractedSet = new Set(extractedReportIds);
      
      // If selection changed, reset to idle to allow new extraction
      const setsMatch = currentReportIds.size === extractedSet.size && 
        Array.from(currentReportIds).every(id => extractedSet.has(id));
      
      if (!setsMatch) {
        setStatus('idle');
        setExtractedData(null);
        setTotalTime(null);
      }
    }
  }, [selectedReports, status, extractedData]);

  // Update refs when state changes
  useEffect(() => {
    processingStatusRef.current = processingStatus;
  }, [processingStatus]);

  useEffect(() => {
    selectedReportsRef.current = selectedReports;
  }, [selectedReports]);

  // Timer effect - use refs to avoid recreating interval on every state change
  // Updates elapsed time and decrements remaining time every second
  useEffect(() => {
    if (status !== 'processing' || !startTimeRef.current) {
      return;
    }

    const interval = setInterval(() => {
      if (!startTimeRef.current) return;

      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      setElapsedTime(elapsed);

      // Decrement remaining time by 1 second (it's recalculated when valuesets complete)
      setRemainingTime(prev => prev !== null && prev > 0 ? prev - 1 : prev);
    }, 1000);

    return () => clearInterval(interval);
  }, [status]); // Only depend on status, not processingStatus or selectedReports

  /**
   * Expands a set of unique hashes with a small concurrency pool.
   * Failures are recorded per hash in ctx.failedByHash and never abort the pass.
   */
  const runExpansionPass = async (
    hashes: string[],
    ctx: ExtractionContext,
    label: string,
  ) => {
    const passStart = Date.now();
    let completedCount = 0;
    const queue = [...hashes];

    const updateStatus = () => {
      const current = Math.min(completedCount + 1, hashes.length);
      setProcessingStatus({
        currentReport: current,
        totalReports: hashes.length,
        reportName: `${ctx.totalInstanceCount} instances across ${ctx.totalReports} reports`,
        currentValueSet: current,
        totalValueSets: hashes.length,
        message: `${label} ${current} of ${hashes.length}`,
      });
    };

    setProgress(0);
    updateStatus();

    const worker = async () => {
      while (queue.length > 0) {
        if (cancellationRef.current) return;
        const hash = queue.shift()!;
        const template = ctx.hashGroups.get(hash)![0];

        try {
          const raw = await expandValueSetClientSide(
            template.vs,
            ctx.translations,
            ctx.historical,
            { isCancelled: () => cancellationRef.current },
          );
          ctx.expandedByHash.set(hash, raw);
          if (raw.expansionError) ctx.failedByHash.set(hash, raw.expansionError);
          else ctx.failedByHash.delete(hash);
        } catch (error) {
          if (error instanceof CancelledError || cancellationRef.current) return;
          const message = coerceErrorMessage(error);
          console.error(`ValueSet expansion failed (hash ${hash}):`, error);
          ctx.failedByHash.set(hash, message);
        }

        completedCount++;
        const elapsedSeconds = (Date.now() - passStart) / 1000;
        const remaining = hashes.length - completedCount;
        setRemainingTime(remaining > 0 ? Math.max(0, Math.ceil(remaining * (elapsedSeconds / completedCount))) : 0);
        setProgress(Math.round((completedCount / hashes.length) * 100));
        updateStatus();
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(EXPANSION_CONCURRENCY, hashes.length) }, () => worker()),
    );
  };

  /** Re-runs expansion for failed ValueSets only and rebuilds the tables */
  const handleRetryFailed = async () => {
    const ctx = extractionCtxRef.current;
    if (!ctx || ctx.failedByHash.size === 0 || isExtracting) return;

    setIsExtracting(true);
    setContextIsExtracting(true);
    cancellationRef.current = false;
    setStatus('processing');
    setProgress(0);
    setErrorMessage('');
    const now = Date.now();
    setStartTime(now);
    startTimeRef.current = now;
    setElapsedTime(0);
    setRemainingTime(null);

    try {
      await runExpansionPass(Array.from(ctx.failedByHash.keys()), ctx, 'Retrying failed ValueSet');

      const tables = buildNormalizedTables(
        ctx.selectedReports,
        ctx.instances,
        ctx.expandedByHash,
        ctx.failedByHash,
        ctx.translations,
        ctx.historical,
        equivalenceFilter,
        ctx.equivalences,
      );
      setExtractedData(tables);
      setFailedCount(ctx.failedByHash.size);
      setProcessingStatus(null);
      setStatus('completed');
    } catch (error) {
      if (!cancellationRef.current && !(error instanceof CancelledError)) {
        console.error('Retry failed:', error);
        setStatus('error');
        setErrorMessage(coerceErrorMessage(error));
        setProcessingStatus(null);
      }
    } finally {
      setIsExtracting(false);
      setContextIsExtracting(false);
      cancellationRef.current = false;
      setStartTime(null);
      startTimeRef.current = null;
      setElapsedTime(0);
      setRemainingTime(null);
    }
  };

  const handleExtract = async () => {
    if (selectedReports.length === 0) return;

    setIsExtracting(true);
    setContextIsExtracting(true);
    cancellationRef.current = false;
    setStatus('processing');
    setProgress(0);
    setErrorMessage('');
    setFailedCount(0);
    const now = Date.now();
    setStartTime(now);
    startTimeRef.current = now;
    setElapsedTime(0);
    setRemainingTime(null);
    setTotalTime(null);

    let extractionCompleted = false;
    try {
      const totalReports = selectedReports.length;
      const isCancelled = () => cancellationRef.current;

      // === Phase 1: Collect all ValueSets with their hashes ===
      const allInstances: ExtractionInstance[] = [];

      for (const report of selectedReports) {
        // Deduplicate ValueSets within report by code content (matching explore mode logic)
        const reportCodeKeys = new Set<string>();
        let reportVsCounter = 0;
        for (const vs of report.valueSets) {
          const codes = vs.values.map((v: any) => v.code).sort();
          const codeKey = generateExpansionKey(vs);

          if (reportCodeKeys.has(codeKey)) continue; // skip duplicate within report
          reportCodeKeys.add(codeKey);

          allInstances.push({ report, vsIndex: reportVsCounter++, vs, hash: generateValueSetHash(codes), expansionKey: codeKey });
        }
      }

      // Group by hash — only expand unique hashes
      const hashGroups = new Map<string, ExtractionInstance[]>();
      for (const instance of allInstances) {
        if (!hashGroups.has(instance.expansionKey!)) {
          hashGroups.set(instance.expansionKey!, []);
        }
        hashGroups.get(instance.expansionKey!)!.push(instance);
      }

      const uniqueHashes = Array.from(hashGroups.keys());
      const totalUniqueValueSets = uniqueHashes.length;
      const totalInstanceCount = allInstances.length;

      console.log(`Deduplication: ${totalInstanceCount} ValueSet instances -> ${totalUniqueValueSets} unique code sets`);

      // Collect ALL unique codes across all unique ValueSets for global translation
      const allUniqueCodes = new Set<string>();
      for (const hash of uniqueHashes) {
        const template = hashGroups.get(hash)![0];
        template.vs.values.forEach((v: any) => allUniqueCodes.add(v.code));
        template.vs.exceptions.forEach((e: any) => allUniqueCodes.add(e.code));
      }
      console.log(`Collected ${allUniqueCodes.size} unique codes for global translation`);

      if (cancellationRef.current) {
        setStatus('idle'); setProcessingStatus(null);
        setIsExtracting(false); setContextIsExtracting(false);
        return;
      }

      // === Phase 2: Global translation (chunked — each code is an HTTP request server-side) ===
      const TRANSLATE_CHUNK_SIZE = 200;
      const allCodesArray = Array.from(allUniqueCodes);
      const globalTranslations: Record<string, TranslatedCode | null> = {};
      const globalEquivalences: Record<string, string> = {};
      const translateChunkCount = Math.ceil(allCodesArray.length / TRANSLATE_CHUNK_SIZE);

      for (let i = 0; i < allCodesArray.length; i += TRANSLATE_CHUNK_SIZE) {
        if (cancellationRef.current) {
          setStatus('idle'); setProcessingStatus(null);
          setIsExtracting(false); setContextIsExtracting(false);
          return;
        }

        const chunkIndex = Math.floor(i / TRANSLATE_CHUNK_SIZE) + 1;
        const chunk = allCodesArray.slice(i, i + TRANSLATE_CHUNK_SIZE);

        setProcessingStatus({
          currentReport: 0, totalReports: totalUniqueValueSets,
          reportName: `${totalInstanceCount} instances across ${totalReports} reports`,
          currentValueSet: 0, totalValueSets: totalUniqueValueSets,
          message: `Translating codes (batch ${chunkIndex}/${translateChunkCount}, ${Math.min(i + TRANSLATE_CHUNK_SIZE, allCodesArray.length)}/${allCodesArray.length})...`,
        });

        const translateData = await fetchApi<{ translations?: Record<string, TranslatedCode | null>; equivalences?: Record<string, string> }>(
          '/api/terminology/translate',
          { codes: chunk, equivalenceFilter },
          { isCancelled },
        );
        Object.assign(globalTranslations, translateData.translations || {});
        Object.assign(globalEquivalences, translateData.equivalences || {});
      }

      const translatedCount = Object.values(globalTranslations).filter(t => t !== null).length;
      console.log(`Global translation: ${translatedCount}/${allUniqueCodes.size} codes translated`);

      // === Phase 3: Global historical resolution (chunked) ===
      const snomedCodesToResolve = new Set<string>();
      for (const [code, translated] of Object.entries(globalTranslations)) {
        if (translated) {
          snomedCodesToResolve.add(translated.code);
        } else {
          snomedCodesToResolve.add(code);
        }
      }
      for (const code of allUniqueCodes) {
        if (!(code in globalTranslations)) {
          snomedCodesToResolve.add(code);
        }
      }

      const RESOLVE_CHUNK_SIZE = 500;
      const resolveArray = Array.from(snomedCodesToResolve);
      const globalHistorical: Record<string, string> = {};
      const resolveChunkCount = Math.ceil(resolveArray.length / RESOLVE_CHUNK_SIZE);

      for (let i = 0; i < resolveArray.length; i += RESOLVE_CHUNK_SIZE) {
        if (cancellationRef.current) {
          setStatus('idle'); setProcessingStatus(null);
          setIsExtracting(false); setContextIsExtracting(false);
          return;
        }

        const chunkIndex = Math.floor(i / RESOLVE_CHUNK_SIZE) + 1;
        const chunk = resolveArray.slice(i, i + RESOLVE_CHUNK_SIZE);

        setProcessingStatus({
          currentReport: 0, totalReports: totalUniqueValueSets,
          reportName: `${totalInstanceCount} instances across ${totalReports} reports`,
          currentValueSet: 0, totalValueSets: totalUniqueValueSets,
          message: `Resolving historical concepts (batch ${chunkIndex}/${resolveChunkCount}, ${Math.min(i + RESOLVE_CHUNK_SIZE, resolveArray.length)}/${resolveArray.length})...`,
        });

        const resolveData = await fetchApi<{ resolutions?: Record<string, { currentConceptId: string; isHistorical: boolean }> }>(
          '/api/terminology/resolve-historical',
          { conceptIds: chunk },
          { isCancelled },
        );

        for (const [conceptId, resolution] of Object.entries(resolveData.resolutions || {})) {
          const res = resolution as { currentConceptId: string; isHistorical: boolean };
          if (res.isHistorical) {
            globalHistorical[conceptId] = res.currentConceptId;
          }
        }
      }
      console.log(`Historical resolution: ${Object.keys(globalHistorical).length} concepts updated`);

      if (cancellationRef.current) {
        setStatus('idle'); setProcessingStatus(null);
        setIsExtracting(false); setContextIsExtracting(false);
        return;
      }

      // === Phase 4: Per-ValueSet expansion (client-driven, bounded server calls) ===
      const ctx: ExtractionContext = {
        instances: allInstances,
        hashGroups,
        expandedByHash: new Map<string, RawValueSetExpansion>(),
        failedByHash: new Map<string, string>(),
        translations: globalTranslations,
        historical: globalHistorical,
        equivalences: globalEquivalences,
        selectedReports: [...selectedReports],
        totalInstanceCount,
        totalReports,
      };
      extractionCtxRef.current = ctx;

      await runExpansionPass(uniqueHashes, ctx, 'Expanding ValueSet');
      if (cancellationRef.current) {
        setStatus('idle'); setProcessingStatus(null);
        setIsExtracting(false); setContextIsExtracting(false);
        return;
      }

      // One automatic retry pass — transient platform errors usually clear
      if (ctx.failedByHash.size > 0) {
        console.warn(`Retrying ${ctx.failedByHash.size} failed ValueSet(s)...`);
        await runExpansionPass(Array.from(ctx.failedByHash.keys()), ctx, 'Retrying failed ValueSet');
        if (cancellationRef.current) {
          setStatus('idle'); setProcessingStatus(null);
          setIsExtracting(false); setContextIsExtracting(false);
          return;
        }
      }

      // === Phase 5: Client-side assembly (failures recorded in expansion_error) ===
      const tables = buildNormalizedTables(
        ctx.selectedReports,
        ctx.instances,
        ctx.expandedByHash,
        ctx.failedByHash,
        ctx.translations,
        ctx.historical,
        equivalenceFilter,
        ctx.equivalences,
      );

      setExtractedData(tables);
      setFailedCount(ctx.failedByHash.size);
      setProcessingStatus(null);
      const finalTime = startTimeRef.current ? Math.floor((Date.now() - startTimeRef.current) / 1000) : 0;
      setTotalTime(finalTime);
      setStatus('completed');
      extractionCompleted = true;
    } catch (error) {
      if (!cancellationRef.current && !(error instanceof CancelledError)) {
        console.error('Batch extraction error:', error);
        setStatus('error');
        setErrorMessage(coerceErrorMessage(error));
        setProcessingStatus(null);
      }
    } finally {
      setIsExtracting(false);
      setContextIsExtracting(false);
      cancellationRef.current = false;
      // Only clear timing if not completed (preserve totalTime for completed extractions)
      if (!extractionCompleted) {
        setStartTime(null);
        startTimeRef.current = null;
        setElapsedTime(0);
        setRemainingTime(null);
        setTotalTime(null);
      } else {
        // Clear these but keep totalTime
        setStartTime(null);
        startTimeRef.current = null;
        setElapsedTime(0);
        setRemainingTime(null);
      }
    }
  };

  const handleCancel = () => {
    cancellationRef.current = true;
    setStatus('idle');
    setProcessingStatus(null);
    setIsExtracting(false);
    setContextIsExtracting(false);
    setProgress(0);
    setStartTime(null);
    setElapsedTime(0);
    setRemainingTime(null);
  };

  const handleDownloadZIP = async () => {
    if (!extractedData) return;

    try {
      // Dynamic import of JSZip
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      // Add each CSV file to the ZIP
      if (extractedData.reports.length > 0) {
        zip.file('reports.csv', convertToCSV(extractedData.reports));
      }
      if (extractedData.valuesets.length > 0) {
        zip.file('valuesets.csv', convertToCSV(extractedData.valuesets));
      }
      if (extractedData.originalCodes.length > 0) {
        zip.file('original_codes.csv', convertToCSV(extractedData.originalCodes));
      }
      if (extractedData.expandedConcepts.length > 0) {
        zip.file('expanded_concepts.csv', convertToCSV(extractedData.expandedConcepts));
      }
      if (extractedData.failedCodes.length > 0) {
        zip.file('failed_codes.csv', convertToCSV(extractedData.failedCodes));
      }
      if (extractedData.exceptions.length > 0) {
        zip.file('exceptions.csv', convertToCSV(extractedData.exceptions));
      }

      // Implementation guides — one per report, mirroring the folder tree.
      // Content is deterministic (no timestamps), so guides generated from
      // different XML versions can be diffed directly.
      const sortedReports = [...selectedReports].sort(
        (a, b) => a.rule.localeCompare(b.rule) || a.searchName.localeCompare(b.searchName),
      );
      const usedPaths = new Set<string>();
      const indexLines: string[] = ['# Implementation guides', ''];
      let lastFolder = '';
      for (const report of sortedReports) {
        const folderSegments = report.rule.split(' > ').slice(1).map(slugifyFileName);
        const basePath = ['guides', ...folderSegments, slugifyFileName(report.searchName)].join('/');
        let filePath = `${basePath}.md`;
        for (let suffix = 2; usedPaths.has(filePath); suffix++) {
          filePath = `${basePath}-${suffix}.md`;
        }
        usedPaths.add(filePath);
        zip.file(filePath, buildImplementationGuideMarkdown(report, reports));

        const folderLabel = report.rule.split(' > ').slice(1).join(' > ') || 'Top level';
        if (folderLabel !== lastFolder) {
          indexLines.push('', `## ${folderLabel}`, '');
          lastFolder = folderLabel;
        }
        const linkText = report.searchName.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
        indexLines.push(`- [${linkText}](${filePath.replace(/^guides\//, '')})`);
      }
      zip.file('guides/index.md', `${indexLines.join('\n').trim()}\n`);

      // Generate ZIP file
      const zipBlob = await zip.generateAsync({ type: 'blob' });

      // Download ZIP
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `emis-snomed-extract-${new Date().toISOString().split('T')[0]}.zip`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error creating ZIP:', error);
      alert('Failed to create ZIP file. Please try again.');
    }
  };

  // No XML loaded (only show after checking)
  if (!isCheckingXml && reports.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-full p-6">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6">
            <div className="text-center space-y-4">
              <FileText className="h-12 w-12 mx-auto text-muted-foreground" />
              <div>
                <h3 className="text-lg font-semibold mb-2">No XML File Loaded</h3>
                <p className="text-sm text-muted-foreground">
                  Upload an XML file from the sidebar to get started with batch extraction
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // No reports selected
  if (selectedReports.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-full p-6">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6">
            <div className="text-center space-y-4">
              <Package className="h-12 w-12 mx-auto text-muted-foreground" />
              <div>
                <h3 className="text-lg font-semibold mb-2">No Reports Selected</h3>
                <p className="text-sm text-muted-foreground">
                  Select one or more reports from the sidebar to begin batch extraction
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 w-full max-w-full min-w-0">
      {/* Selected Reports & Extract Action */}
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold">Selected Reports</h2>
          <Badge variant="secondary">{selectedReports.length}</Badge>
        </div>

        <Card className={status === 'idle' ? 'bg-primary/5 border-primary/20' : 'shadow-sm'}>
          <CardContent className="pt-4">
            <div className="grid gap-2 sm:grid-cols-2 max-h-60 overflow-y-auto pr-1">
              {selectedReports.map((report) => (
                <div
                  key={report.id}
                  className="flex items-start justify-between gap-3 p-2 rounded-md border border-border/60 bg-muted/40 hover:bg-muted/70 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{report.searchName}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {report.valueSets.length} ValueSet{report.valueSets.length !== 1 ? 's' : ''}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 flex-shrink-0"
                    onClick={() => toggleReportSelection(report.id)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>

            {status === 'idle' && (
              <div className="mt-4 pt-4 border-t flex flex-col items-center text-center space-y-3">
                <p className="text-sm text-foreground/80 max-w-2xl">
                  This will expand SNOMED codes for all selected reports and generate normalised tables ready for data warehouse import.
                </p>
                <Button
                  onClick={handleExtract}
                  disabled={isExtracting}
                  size="lg"
                  className="text-base px-8 py-6 h-auto [&_svg]:size-6"
                >
                  <Package className="mr-2" />
                  Extract All
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Processing Status */}
      {status === 'processing' && processingStatus && (
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <Loader2 className="h-5 w-5 animate-spin text-primary flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold">Expanding Unique ValueSets</h3>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Unique ValueSet {processingStatus.currentReport} of {processingStatus.totalReports} ({processingStatus.reportName})
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {processingStatus.message}
                    </p>
                  </div>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleCancel}
                  className="gap-2 flex-shrink-0"
                >
                  <XCircle className="h-4 w-4" />
                  Cancel
                </Button>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-muted-foreground">Overall Progress</span>
                  <span className="text-xs font-medium">{Math.round(progress)}%</span>
                </div>
                <div className="relative h-2 w-full overflow-hidden rounded-full bg-blue-100 dark:bg-blue-900/20">
                  <div 
                    className="h-full bg-blue-600 dark:bg-blue-500 transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
                  <span>Elapsed: {formatTime(elapsedTime)}</span>
                  {remainingTime !== null && (
                    <span>Remaining: {formatTime(remainingTime)}</span>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Completed Status */}
      {status === 'completed' && extractedData && (
        <Card className="border-green-200 bg-green-50/50">
          <CardContent className="pt-6">
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                <div className="flex-1">
                  <h3 className="font-semibold text-green-900">Extraction Complete</h3>
                  <p className="text-sm text-green-700">
                    Successfully processed {selectedReports.length} reports
                    {totalTime !== null && totalTime >= 0 && (
                      <> in {formatTimeNatural(totalTime)}</>
                    )}
                  </p>
                </div>
              </div>
              {failedCount > 0 && (
                <div className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-3">
                  <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 text-sm text-amber-900">
                    <span className="font-medium">
                      {failedCount} unique ValueSet{failedCount !== 1 ? 's' : ''} failed to expand.
                    </span>{' '}
                    Affected rows are included with the reason recorded in the{' '}
                    <code className="text-xs">expansion_error</code> column of valuesets.csv.
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRetryFailed}
                    disabled={isExtracting}
                    className="flex-shrink-0"
                  >
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    Retry Failed
                  </Button>
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
                <div className="bg-white/50 p-2 rounded">
                  <div className="text-xs text-muted-foreground">Reports</div>
                  <div className="font-semibold">{extractedData.reports.length}</div>
                </div>
                <div className="bg-white/50 p-2 rounded">
                  <div className="text-xs text-muted-foreground">ValueSets</div>
                  <div className="font-semibold">{extractedData.valuesets.length}</div>
                </div>
                <div className="bg-white/50 p-2 rounded">
                  <div className="text-xs text-muted-foreground">Expanded Concepts</div>
                  <div className="font-semibold">{extractedData.expandedConcepts.length}</div>
                </div>
                <div className="bg-white/50 p-2 rounded">
                  <div className="text-xs text-muted-foreground">Original Codes</div>
                  <div className="font-semibold">{extractedData.originalCodes.length}</div>
                </div>
                <div className="bg-white/50 p-2 rounded">
                  <div className="text-xs text-muted-foreground">Failed Codes</div>
                  <div className="font-semibold">{extractedData.failedCodes.length}</div>
                </div>
                <div className="bg-white/50 p-2 rounded">
                  <div className="text-xs text-muted-foreground">Exceptions</div>
                  <div className="font-semibold">{extractedData.exceptions.length}</div>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <Button onClick={handleDownloadZIP} variant="default">
                  <Download className="mr-2 h-4 w-4" />
                  Download ZIP Bundle
                </Button>
                <Button onClick={() => setIsDataViewerOpen(true)} variant="outline">
                  <Database className="mr-2 h-4 w-4" />
                  View Data
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Error Status */}
      {status === 'error' && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-destructive mb-1">Extraction Failed</h3>
                <p className="text-sm text-muted-foreground mb-3">
                  {errorMessage || 'An error occurred while processing the reports. Please try again.'}
                </p>
                {/* Show helpful tips based on error type */}
                {errorMessage && getErrorSuggestions(errorMessage).length > 0 && (
                  <div className="bg-muted/50 rounded-md p-3 text-xs space-y-1">
                    <p className="font-medium">Suggestions:</p>
                    <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                      {getErrorSuggestions(errorMessage).map((suggestion) => (
                        <li key={suggestion}>{suggestion}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    setStatus('idle');
                    setErrorMessage('');
                    setProgress(0);
                  }}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Info Card */}
      <Card>
        <CardContent className="pt-6 p-0">
          <div className="divide-y divide-border">
            <div className="p-6">
              <ExtractionFileList />
            </div>
            <div className="p-6">
              <ExtractionDataModel />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Data Viewer Dialog */}
      {extractedData && (
        <ExtractionDataViewer
          open={isDataViewerOpen}
          onOpenChange={setIsDataViewerOpen}
          data={extractedData}
        />
      )}
    </div>
  );
}
