# Normalised Data Model for EMIS XML SNOMED Analyser

## Overview
This document outlines the normalised data model for storing valueset data from EMIS XML exports, designed for eventual Snowflake integration.

## Entity Relationship Diagram

```
reports (1) ──< (many) valuesets (1) ──< (many) original_codes
                                              └──< (many) expanded_concepts
                                              └──< (many) failed_codes
                                              └──< (many) exceptions
```

## Tables

### 1. reports
Stores report metadata from the XML file.

| Column | Type | Description | Constraints |
|--------|------|-------------|-------------|
| report_id | VARCHAR | Unique identifier for the report | PK |
| report_name | VARCHAR | Full report name from XML | |
| search_name | VARCHAR | Extracted search name (from brackets) | |
| folder_path | VARCHAR | Full folder path (rule) in XML hierarchy | |
| xml_file_name | VARCHAR | Name of the source XML file | |
| parsed_at | TIMESTAMP_NTZ | When the XML was parsed | |

### 2. valuesets
Stores valueset metadata, linked to reports.

| Column | Type | Description | Constraints |
|--------|------|-------------|-------------|
| valueset_id | VARCHAR | Unique identifier for the valueset | PK |
| report_id | VARCHAR | Reference to parent report | FK → reports |
| valueset_index | INTEGER | Index of valueset within report (0-based) | |
| valueset_hash | VARCHAR(16) | SHA-256 hash of original codes (for duplicate detection) | |
| valueset_friendly_name | VARCHAR | Human-readable valueset name | |
| valueset_short_name | VARCHAR | Short acronym name | |
| code_system | VARCHAR | Code system from XML (e.g., "SNOMED_CONCEPT", "EMIS") | |
| ecl_expression | VARCHAR | Formatted ECL expression representing the entire valueset (no URL encoding, no descriptions) | NULLABLE |
| expansion_error | VARCHAR | Error message if expansion failed | NULLABLE |
| expanded_at | TIMESTAMP_NTZ | When the valueset was expanded | |

### 3. original_codes
Stores original codes from the XML file.

| Column | Type | Description | Constraints |
|--------|------|-------------|-------------|
| original_code_id | VARCHAR | Unique identifier | PK |
| valueset_id | VARCHAR | Reference to parent valueset | FK → valuesets |
| original_code | VARCHAR | Original code from XML | |
| display_name | VARCHAR | Display name from XML | |
| code_system | VARCHAR | Code system (e.g., "SNOMED_CONCEPT", "EMIS") | |
| include_children | BOOLEAN | Whether to include child concepts | |
| is_refset | BOOLEAN | Whether this is a refset ID | |
| translated_to_snomed_code | VARCHAR | SNOMED code after ConceptMap translation | NULLABLE |
| translated_to_display | VARCHAR | Display name of translated SNOMED code | NULLABLE |
| translation_equivalence | VARCHAR | Per-code relationship returned by the primary EMIS CodeID ConceptMap, including equivalent, wider, narrower and inexact. `unmapped` means no map match. Retained when the expansion filter rejects the target. Separate from XML include_children. | |

### 4. expanded_concepts
Stores concepts returned by the terminology server.

| Column | Type | Description | Constraints |
|--------|------|-------------|-------------|
| concept_id | VARCHAR | Unique identifier | PK |
| valueset_id | VARCHAR | Reference to parent valueset | FK → valuesets |
| snomed_code | VARCHAR | SNOMED CT concept code | |
| display | VARCHAR | Display name from terminology server | |
| source | VARCHAR | Source of expansion: 'rf2_file' or 'terminology_server' | |
| exclude_children | BOOLEAN | True if includeChildren was false for parent | |

### 5. failed_codes
Stores codes that failed to translate or expand.

| Column | Type | Description | Constraints |
|--------|------|-------------|-------------|
| failed_code_id | VARCHAR | Unique identifier | PK |
| valueset_id | VARCHAR | Reference to parent valueset | FK → valuesets |
| original_code | VARCHAR | Original code from XML that failed | |
| display_name | VARCHAR | Display name from XML | |
| code_system | VARCHAR | Code system (e.g., "EMISINTERNAL", "EMIS") | |
| reason | VARCHAR | Reason for failure | |

### 6. exceptions
Stores excluded codes for each valueset with translation tracking.

| Column | Type | Description | Constraints |
|--------|------|-------------|-------------|
| exception_id | VARCHAR | Unique identifier | PK |
| valueset_id | VARCHAR | Reference to parent valueset | FK → valuesets |
| original_excluded_code | VARCHAR | Original excluded code from XML | |
| translated_to_snomed_code | VARCHAR | Translated SNOMED code if successful | NULLABLE |
| included_in_ecl | BOOLEAN | Whether code was included in ECL MINUS clause | |
| translation_error | VARCHAR | Error message if translation failed | NULLABLE |

Local extraction also writes `exception_resolution_audit.json`. It records each
exception occurrence's target, resolution status, descendant scope and reason.
`resolved_family` removes an exact active preparation family or mapped clinical
family. `inactive_exact` removes an exact inactive dm+d product and its
descendants. `legacy_exact` keeps the loaded exact target, including a null
target, without descendant subtraction. See the local extraction instructions in
`README.md` for the loaded-target snapshot. These fields are audit metadata and
do not add columns to the exception CSV.

## Indexes

- `idx_valuesets_report_id` on `valuesets(report_id)`
- `idx_original_codes_valueset_id` on `original_codes(valueset_id)`
- `idx_expanded_concepts_valueset_id` on `expanded_concepts(valueset_id)`
- `idx_expanded_concepts_snomed_code` on `expanded_concepts(snomed_code)`
- `idx_failed_codes_valueset_id` on `failed_codes(valueset_id)`
- `idx_exceptions_valueset_id` on `exceptions(valueset_id)`
- `idx_valuesets_hash` on `valuesets(valueset_hash)` (for duplicate detection)

## Snowflake Integration Strategy

### Option 1: CSV Export → Snowflake COPY INTO
1. User selects reports to export
2. Generate CSV files for each table
3. Upload to Snowflake stage (S3, Azure Blob, or internal stage)
4. Use COPY INTO to load data

### Option 2: Direct API Connection
1. Use Snowflake Connector for Python/Node.js
2. Generate INSERT statements or use bulk insert
3. Requires Snowflake credentials configuration

### Option 3: JSON Export → VARIANT Column
1. Export as JSON per report/valueset
2. Load into Snowflake VARIANT column
3. Query using SQL with JSON functions

### Recommended Approach: Option 1 (CSV Export)
- Most flexible and user-friendly
- No need to manage Snowflake credentials in the app
- Users can review data before loading
- Supports incremental updates
- Works with any Snowflake setup

## UI/UX Considerations

### Report Selection
- Add checkboxes to report list in sidebar
- "Select All" / "Deselect All" functionality
- Show count of selected reports
- Filter/search for reports

### Export Interface
- Button: "Export Selected Reports to Snowflake"
- Options:
  - Export format (CSV, JSON, SQL INSERT statements)
  - Include/exclude tables
  - Date range filter
- Progress indicator for large exports
- Download or direct upload option

### Data Preview
- Show normalised tables below valueset display
- Toggle between "Expanded View" and "Normalised View"
- Export individual tables or all tables


### Exception audit scope and equivalence

The seven-column exceptions CSV retains one primary target per XML exception.
`exception_resolution_audit.json` also carries scope, override version and any
additional retained target. Consumers must use that audit to distinguish exact
subtraction from descendant subtraction. The CSV alone does not express scope.

Original-code `translation_equivalence` can describe a primary CodeID map match
while the selected target comes from DrugCodeID fallback. `unmapped` also covers a
match that returned no equivalence part. Manual exception overrides do not change
that recorded ConceptMap relationship.
