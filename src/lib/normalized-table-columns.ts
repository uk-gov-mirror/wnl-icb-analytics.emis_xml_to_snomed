/**
 * Shared column definitions for normalized data tables
 * Used by both explore mode (normalised-data-view) and extract mode (batch data viewer)
 */

export const normalizedTableColumns = {
  reports: [
    { key: 'report_id', label: 'report_id' },
    { key: 'report_xml_id', label: 'report_xml_id' },
    { key: 'report_name', label: 'report_name' },
    { key: 'search_name', label: 'search_name' },
    { key: 'description', label: 'description' },
    { key: 'parent_type', label: 'parent_type' },
    { key: 'parent_report_id', label: 'parent_report_id' },
    { key: 'folder_path', label: 'folder_path' },
    { key: 'xml_file_name', label: 'xml_file_name' },
    { key: 'equivalence_filter_setting', label: 'equivalence_filter_setting' },
    { key: 'parsed_at', label: 'parsed_at' },
  ],
  valuesets: [
    { key: 'valueset_id', label: 'valueset_id' },
    { key: 'report_id', label: 'report_id' },
    { key: 'valueset_index', label: 'valueset_index' },
    { key: 'valueset_hash', label: 'valueset_hash' },
    { key: 'valueset_friendly_name', label: 'valueset_friendly_name' },
    { key: 'code_system', label: 'code_system' },
    { key: 'ecl_expression', label: 'ecl_expression' },
    { key: 'expansion_error', label: 'expansion_error' },
    { key: 'expanded_at', label: 'expanded_at' },
  ],
  originalCodes: [
    { key: 'original_code_id', label: 'original_code_id' },
    { key: 'valueset_id', label: 'valueset_id' },
    { key: 'original_code', label: 'original_code' },
    { key: 'display_name', label: 'display_name' },
    { key: 'code_system', label: 'code_system' },
    { key: 'include_children', label: 'include_children' },
    { key: 'is_refset', label: 'is_refset' },
    { key: 'translated_to_snomed_code', label: 'translated_to_snomed_code' },
    { key: 'translated_to_display', label: 'translated_to_display' },
    { key: 'translation_equivalence', label: 'translation_equivalence' },
  ],
  expandedConcepts: [
    { key: 'concept_id', label: 'concept_id' },
    { key: 'valueset_id', label: 'valueset_id' },
    { key: 'snomed_code', label: 'snomed_code' },
    { key: 'display', label: 'display' },
    { key: 'source', label: 'source' },
    { key: 'exclude_children', label: 'exclude_children' },
    { key: 'is_descendant', label: 'is_descendant' },
  ],
  failedCodes: [
    { key: 'failed_code_id', label: 'failed_code_id' },
    { key: 'valueset_id', label: 'valueset_id' },
    { key: 'original_code', label: 'original_code' },
    { key: 'display_name', label: 'display_name' },
    { key: 'code_system', label: 'code_system' },
    { key: 'reason', label: 'reason' },
  ],
  exceptions: [
    { key: 'exception_id', label: 'exception_id' },
    { key: 'valueset_id', label: 'valueset_id' },
    { key: 'original_excluded_code', label: 'original_excluded_code' },
    { key: 'original_excluded_display', label: 'original_excluded_display' },
    { key: 'translated_to_snomed_code', label: 'translated_to_snomed_code' },
    { key: 'included_in_ecl', label: 'included_in_ecl' },
    { key: 'translation_error', label: 'translation_error' },
  ],
} as const;

export type NormalizedTableName = keyof typeof normalizedTableColumns;
