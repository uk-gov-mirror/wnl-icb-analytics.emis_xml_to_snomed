'use client';

import { useState } from 'react';
import { Database, Key, ChevronRight } from 'lucide-react';

interface TableInfo {
  name: string;
  primaryKey: string;
  foreignKeys: { column: string; references: string }[];
  columns: string[];
}

const TABLES: TableInfo[] = [
  {
    name: 'reports',
    primaryKey: 'report_id',
    foreignKeys: [],
    columns: ['report_id', 'report_xml_id', 'report_name', 'search_name', 'description', 'parent_type', 'parent_report_id', 'folder_path', 'xml_file_name', 'equivalence_filter_setting', 'parsed_at'],
  },
  {
    name: 'valuesets',
    primaryKey: 'valueset_id',
    foreignKeys: [{ column: 'report_id', references: 'reports.report_id' }],
    columns: ['valueset_id', 'report_id', 'valueset_index', 'valueset_hash', 'valueset_friendly_name', 'code_system', 'ecl_expression', 'expansion_error', 'expanded_at'],
  },
  {
    name: 'original_codes',
    primaryKey: 'original_code_id',
    foreignKeys: [{ column: 'valueset_id', references: 'valuesets.valueset_id' }],
    columns: ['original_code_id', 'valueset_id', 'original_code', 'display_name', 'code_system', 'include_children', 'is_refset', 'translated_to_snomed_code', 'translated_to_display', 'translation_equivalence'],
  },
  {
    name: 'expanded_concepts',
    primaryKey: 'concept_id',
    foreignKeys: [{ column: 'valueset_id', references: 'valuesets.valueset_id' }],
    columns: ['concept_id', 'valueset_id', 'snomed_code', 'display', 'source', 'exclude_children', 'is_descendant'],
  },
  {
    name: 'failed_codes',
    primaryKey: 'failed_code_id',
    foreignKeys: [{ column: 'valueset_id', references: 'valuesets.valueset_id' }],
    columns: ['failed_code_id', 'valueset_id', 'original_code', 'display_name', 'code_system', 'reason'],
  },
  {
    name: 'exceptions',
    primaryKey: 'exception_id',
    foreignKeys: [{ column: 'valueset_id', references: 'valuesets.valueset_id' }],
    columns: ['exception_id', 'valueset_id', 'original_excluded_code', 'original_excluded_display', 'translated_to_snomed_code', 'included_in_ecl', 'translation_error'],
  },
];

function TableCard({ table }: { table: TableInfo }) {
  return (
    <div className="rounded-lg border bg-background shadow-sm overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b bg-muted/50">
        <span className="font-mono text-xs font-semibold">{table.name}</span>
      </div>
      <div className="p-1.5 space-y-px">
        {table.columns.map((column) => {
          const isPrimaryKey = column === table.primaryKey;
          const foreignKey = table.foreignKeys.find((fk) => fk.column === column);
          return (
            <div
              key={column}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] leading-4 ${
                isPrimaryKey
                  ? 'bg-primary/10 text-primary font-semibold'
                  : foreignKey
                  ? 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                  : 'text-muted-foreground'
              }`}
            >
              {isPrimaryKey && <Key className="h-2.5 w-2.5 flex-shrink-0" />}
              <span className="truncate">{column}</span>
              {foreignKey && (
                <span className="ml-auto text-[10px] opacity-70 flex-shrink-0">
                  → {foreignKey.references.split('.')[0]}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ExtractionDataModel({ className }: { className?: string }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center gap-2 text-left"
      >
        <Database className="h-4 w-4" />
        <h3 className="font-semibold text-sm">Data Model & Relationships</h3>
        <span className="text-xs text-muted-foreground">
          {TABLES.length} tables
        </span>
        <ChevronRight
          className={`ml-auto h-4 w-4 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`}
        />
      </button>

      {isOpen && (
        <div className="mt-4 p-4 bg-muted/20 rounded-lg border space-y-4">
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">reports</span> 1:N{' '}
            <span className="font-mono">valuesets</span> 1:N each child table, joined on the
            highlighted foreign keys.
          </p>

          {/* Parents side by side */}
          <div className="grid gap-3 sm:grid-cols-2">
            <TableCard table={TABLES[0]} />
            <TableCard table={TABLES[1]} />
          </div>

          {/* Children of valuesets */}
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            {TABLES.slice(2).map((table) => (
              <TableCard key={table.name} table={table} />
            ))}
          </div>

          <div className="flex flex-wrap gap-4 pt-3 border-t text-xs">
            <div className="flex items-center gap-1.5">
              <Key className="h-3 w-3 text-primary" />
              <span>Primary key</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-3 w-3 rounded bg-blue-50 border border-blue-200 dark:bg-blue-950 dark:border-blue-800" />
              <span>Foreign key</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
