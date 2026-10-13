'use client';

import { useState, useEffect } from 'react';
import { loadParsedXmlData, clearParsedXmlData } from '@/lib/storage';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import FeatureItem from './feature-item';
import { EmisXmlDocument, RuleGroup, Feature } from '@/lib/types';

export default function SearchHierarchy() {
  const [parsedData, setParsedData] = useState<EmisXmlDocument | null>(null);
  const [ruleGroups, setRuleGroups] = useState<RuleGroup[]>([]);
  const [selectedFeatures, setSelectedFeatures] = useState<Set<string>>(
    new Set()
  );

  const groupReportsIntoRules = (data: EmisXmlDocument) => {
    // Group reports by rule
    const groups = new Map<string, Feature[]>();

    data.reports.forEach((report) => {
        const feature: Feature = {
          id: report.id,
          name: report.searchName,
          displayName: report.name,
          rule: report.rule,
          valueSets: report.valueSets,
          isSelected: false,
          isExpanding: false,
        };

        if (!groups.has(report.rule)) {
          groups.set(report.rule, []);
        }
        groups.get(report.rule)!.push(feature);
      });

      const ruleGroupsArray: RuleGroup[] = Array.from(groups.entries()).map(
        ([ruleName, features]) => ({ ruleName, features })
      );

      setRuleGroups(ruleGroupsArray);
  };

  // Load from IndexedDB on mount
  useEffect(() => {
    loadParsedXmlData()
      .then((minimalData) => {
        if (minimalData) {
          // Reconstruct displayNames (use code as fallback)
          if (minimalData.reports) {
            minimalData.reports.forEach((report: any) => {
              if (report.valueSets) {
                report.valueSets.forEach((vs: any) => {
                  if (vs.values) {
                    vs.values.forEach((v: any) => {
                      v.displayName = v.displayName || v.code;
                    });
                  }
                });
              }
            });
          }
          
          setParsedData(minimalData);
          groupReportsIntoRules(minimalData);
        }
      })
      .catch((error) => {
        console.error('Failed to load stored data:', error);
      });
  }, []);

  // Listen for XML parsing completion
  useEffect(() => {
    const handleXmlParsed = (event: Event) => {
      const customEvent = event as CustomEvent<EmisXmlDocument>;
      setParsedData(customEvent.detail);

      // Storage is handled by folder-tree-navigation component
      // Just process the data for this component
      groupReportsIntoRules(customEvent.detail);
    };

    window.addEventListener('xml-parsed', handleXmlParsed);
    return () => {
      window.removeEventListener('xml-parsed', handleXmlParsed);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectAll = () => {
    const allFeatureIds = ruleGroups.flatMap((g) =>
      g.features.map((f) => f.id)
    );
    setSelectedFeatures(new Set(allFeatureIds));
  };

  const handleDeselectAll = () => {
    setSelectedFeatures(new Set());
  };

  const handleToggleFeature = (featureId: string) => {
    setSelectedFeatures((prev) => {
      const next = new Set(prev);
      if (next.has(featureId)) {
        next.delete(featureId);
      } else {
        next.add(featureId);
      }
      return next;
    });
  };

  if (!parsedData) {
    return (
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Search Selection</CardTitle>
          <CardDescription>Upload an XML file to begin</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Select Searches to Analyse</CardTitle>
        <CardDescription>
          {parsedData.reports.length} searches found, organized by rule
        </CardDescription>
        <div className="flex gap-2 mt-4">
          <Button variant="outline" size="sm" onClick={handleSelectAll}>
            Select All
          </Button>
          <Button variant="outline" size="sm" onClick={handleDeselectAll}>
            Deselect All
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Accordion type="multiple" className="w-full">
          {ruleGroups.map((group, index) => (
            <AccordionItem key={group.ruleName} value={`rule-${index}`}>
              <AccordionTrigger>
                <div className="flex items-center gap-2">
                  <span>{group.ruleName}</span>
                  <Badge variant="secondary">{group.features.length}</Badge>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <div className="space-y-2 pl-4">
                  {group.features.map((feature) => (
                    <FeatureItem
                      key={feature.id}
                      feature={feature}
                      isSelected={selectedFeatures.has(feature.id)}
                      onToggle={() => handleToggleFeature(feature.id)}
                    />
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </CardContent>
    </Card>
  );
}
