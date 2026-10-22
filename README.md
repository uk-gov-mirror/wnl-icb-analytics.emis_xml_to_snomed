# EMIS XML SNOMED Analyzer

A Next.js application for analyzing EMIS XML exports and expanding SNOMED codes using a terminology server API.

## Features

- **Drag-and-drop XML upload**: Upload EMIS search export XML files
- **Hierarchical display**: View searches organized by Rules and Features
- **Selective processing**: Choose specific searches to analyze or select all
- **On-demand code expansion**: Query terminology server only when needed
- **Batched API requests**: Minimize API calls by batching parent codes with ECL OR operators
- **SQL-ready output**: Copy formatted codes as single-quoted, comma-separated values for SQL IN clauses

## Setup

### Prerequisites

- Node.js 18+ and npm
- Access to OntoServer terminology API
- OAuth credentials (CLIENT_ID and CLIENT_SECRET)

### Installation

1. Clone or navigate to the project directory:
```bash
cd C:\Projects\emis_xml_analyser_and_snomed_exporter
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:

Copy `.env.example` to `.env.local` and fill in your credentials:

```bash
ACCESS_TOKEN_URL=https://ontology.onelondon.online/authorisation/auth/realms/terminology/protocol/openid-connect/token
CLIENT_ID=your_client_id_here
CLIENT_SECRET=your_client_secret_here
TERMINOLOGY_SERVER=https://ontology.onelondon.online/production1/fhir
```

### Development

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build for Production

```bash
npm run build
npm run start
```

## Usage

1. **Upload XML**: Drag and drop an EMIS XML export file or click to select
2. **Review Searches**: Expand Rules to see Features (searches) within each Rule
3. **Select Features**: Check boxes next to searches you want to analyze, or use "Select All"
4. **Expand Codes**: Click "Expand Codes" on individual features to query the terminology server
5. **Copy SQL**: Use the "Copy SQL" button to copy formatted codes for database queries

## Architecture

### Technology Stack

- **Framework**: Next.js 15 with App Router
- **Language**: TypeScript (strict mode)
- **UI**: shadcn/ui + Tailwind CSS
- **XML Parsing**: fast-xml-parser (server-side)
- **API**: OAuth 2.0 + FHIR terminology server

### Key Components

- **src/lib/xml-parser.ts**: Parses EMIS XML and extracts Rules, Features, SNOMED codes
- **src/lib/oauth-client.ts**: Manages OAuth tokens with caching
- **src/lib/ecl-builder.ts**: Constructs ECL queries for terminology server
- **src/lib/terminology-client.ts**: Interfaces with FHIR terminology API
- **src/app/api/xml/parse/route.ts**: XML parsing API endpoint
- **src/app/api/terminology/expand/route.ts**: Code expansion API endpoint

### Data Flow

```
1. User uploads XML → Server parses → Returns structured data
2. Client displays Rules → Features (hierarchical view)
3. User selects features → Clicks expand
4. Client sends codes → Server builds ECL query → Terminology API
5. Server returns expanded codes → Client displays SQL-formatted output
```

## API Integration

### OAuth Flow

- Grant type: Client Credentials
- Token caching with 60s expiration buffer
- Singleton pattern prevents concurrent token requests

### Terminology Server

- **Endpoint**: `/ValueSet/$expand`
- **ECL Format**: `<<code1 OR <<code2` (descendants with OR operators)
- **Exclusions**: `(<<code1 OR <<code2) MINUS (<<excluded1)`
- **Response**: FHIR ValueSet expansion with `code`, `display`, `system`

## Development Notes

### Local extraction

With the terminology OAuth environment variables set, run:

```powershell
npx tsx scripts/extract-xml.ts "path/to/searches.xml" "path/to/output" strict
```

This writes six normalised CSVs, a manifest, the per-code translation metadata
and a local terminology-response cache. It does not upload or load data.
`original_codes.csv` appends `translation_equivalence` without changing the
existing columns. The primary CodeID map relationship survives rejection by
the expansion filter. A DrugCodeID relationship supplies the value only when
the primary map has no match. `unmapped` means neither map returned an equivalence part, including a match without that part.
The exported equivalence can describe the primary map while the selected target
comes from the DrugCodeID fallback. It does not describe a manual exception override.

Preparation systems (`SCT_CONST`, `SCT_PREP`, `DrugCodeID`) always use preparation
resolution, including device names such as Turbohaler, Easyhaler, Ellipta and
Respimat. Other systems use terminology-server ancestry. A substance, VTM or
medicinal-product target enters preparation resolution rather than descendant
subtraction. Targets with no current ancestry use exact-only fallback.
The guard does not infer hierarchy level from a display name.

One exact active dm+d VMP/AMP match removes its formulation family. Matching keeps
ingredient-dose pairs, form, device, qualifiers and supplier. Spacing, singular
forms and the position of the dosage form may differ. Ambiguous VMP/AMP matches
remain unresolved. If no single active match exists, one exact inactive dm+d
product supplies the exclusion without historical substitution. Descendants
require verified VMP/AMP ancestry. Otherwise the inactive target is exact-only.
A loaded VMP/AMP is retained exactly alongside an inactive match. Retaining a
loaded VMP never widens its exclusion to its AMPs. The VMP and AMP root concepts
are not preparations and cannot authorise descendant subtraction.

Unresolved preparations use `legacy_exact`, which subtracts the loaded target
without descendants. A loaded null stays null. This deliberately differs from
June's ordinary-ECL branch, which subtracted descendants. Reproducing that branch
for an unresolved preparation could subtract an ingredient family and would
conflict with the policy that ingredient families must never be subtracted.
June's SCT_CONST and RF2 fallback scope was already
exact-only. Structurally clinical exceptions retain descendant subtraction.

For a republish, supply loaded exception targets and the existing catalogue:

```powershell
npx tsx scripts/extract-xml.ts "searches.xml" "output" all "legacy_exception_targets.json" "loaded_catalogue.json"
```

The target file maps original XML exception codes to loaded SNOMED targets or
`null`. A missing fallback key quarantines that value set. Extraction continues;
the publication gate must reject any quarantine. Without this snapshot,
interactive expansion uses the current ConceptMap and historical maps for fallback.

The catalogue is an object with `reports`, `valuesets`, `originalCodes` and
`exceptions` arrays using the lower-case exported field names. A previous
`tables.json` is accepted. Use the loaded catalogue for a first republish, then
carry its identities into later catalogues. The extractor matches reports by
`report_xml_id` and sets by report, code hash, child/refset flags and exceptions.
A unique code-hash match also preserves a formerly collapsed instance. Ambiguous
matches fail before output. Existing report IDs, value-set IDs, indices and
friendly names survive, including CVD_65 `21e3808c-e538-c84d-ad57-ed87efd5ef46`
and AF_61 `98b8e1d3-7db0-0653-9412-2fdf795e6f61`. New instances receive indices
after the loaded maximum. `identity_mapping.json` records the result. Republish
requires this file alongside loaded targets; identity restoration no longer
depends on an external comparison script. The manifest hashes both inputs.

`src/lib/exception-overrides.ts` contains versioned XML exception corrections.
They run before matching and fallback, validate targets against the
terminology server and record their version and reason on every affected audit
row. Prednesol retains its inactive named brand exactly, rather than substituting
all generic soluble tablets. Loderm and topical erythromycin use the UK 2%
solution VMP. The erythromycin override also retains the original international
cutaneous-solution code exactly, so that code cannot re-enter ordinary ECL sets.
Caduet uses a specific international clinical drug exactly because
no UK dm+d preparation was found. These corrections do not change the inclusion
ConceptMap or its recorded equivalence. The list contains the clinical sources;
targets and membership differences still need publication review.
Five generic fluticasone and beclometasone nasal-spray exceptions use their active
nasal VMPs and AMP descendants. Non-nasal inhaled preparations remain included.
The beclometasone overrides also retain the loaded international nasal-spray
code `766418004` exactly, so the family correction cannot reintroduce it.

`exception_translation_mismatches.json` checks both current translations and
the targets actually applied, including loaded fallback and override targets.
It records `applied_target`, `applied_target_display`, scope and affected value-set
IDs beside the translation. A null applied target means no subtraction for that
exception. Targets without a display also need review. The queue includes names
with no shared ingredient or brand token, including overridden candidates.
This is a review queue, not an automatic mapping
rule. Supplier renames and legitimate synonyms can appear. Dose or route errors
that share an ingredient token still require manual review.
The [upstream reporting note](docs/exception-map-upstream-reporting.md) lists
reviewed incorrect targets and their published map versions.

`exception_resolution_audit.json` records every occurrence's targets, status,
`includeDescendants`, override version and reason. `additionalCodes` records another explicit override target with the same scope.
`additionalDescendantCodes` records extra descendant targets with independent
scope. Retained loaded products now use `additionalExactCodes`, which also records
exact exclusions alongside a primary family. Status is
`resolved_family` for active preparations, mapped clinical exceptions and reviewed
active overrides, `inactive_exact` for inactive matches, or `legacy_exact` for
fallback. Read scope from `includeDescendants`, not status. These audit fields do
not change the seven-column exception CSV. That CSV carries the primary target;
its downstream consumers must not infer scope from the target alone. Review every
`expansion_error`, override and membership diff before publication.

Product searches page to the reported total, retry transient failures and reject
repeated or missing pages. Exceptions resolve sequentially to avoid an unbounded
search burst. The full server ECL path also checks completeness at a server page
cap. The interactive resolver still accepts at most 200 exceptions per request,
inactive search still scans the general SNOMED index, and large SCT_CONST
exclusion lists still share one encoded URL. Those limits fail loudly; larger
exports need a separate request-batching change.

Expansion reuse includes each instance's code system, child/refset flags and
exception codes and names. The original code-only hash remains in the export.
Subtraction respects each exception's scope after combining RF2, ordinary ECL
and recursive SCT_CONST product results.

- Server Components used for API integration (OAuth, parsing)
- Client Components for interactive features (drag-drop, checkboxes)
- Custom events used for XML parsing → hierarchy display communication
- Toast notifications for success/error feedback

## Troubleshooting

### OAuth errors
- Verify CLIENT_ID and CLIENT_SECRET in `.env.local`
- Check ACCESS_TOKEN_URL is correct

### XML parsing errors
- Ensure XML file is valid EMIS export format
- Check browser console for detailed error messages

### Terminology API errors
- Verify TERMINOLOGY_SERVER URL
- Check network connectivity to OntoServer
- Review API rate limits

## License

ISC
