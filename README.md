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
the primary map has no match. `unmapped` means neither map returned a match.

Named preparation exceptions require one exact active VMP/AMP match, including
ingredient, strength, form and brand. Spacing and the position of the dosage
form may differ. The resolver does not infer dose conversions, substitute an
ingredient family or use a historical replacement without preparation evidence.
Unresolved exceptions quarantine the whole value set: its metadata and reasons
remain in the export, with no partial expanded-concept rows. Review every
`expansion_error` before publication. Quarantined files cannot replace a complete
published catalogue.

Expansion reuse includes each instance's code system, child/refset flags and
exception codes and names. The original code-only hash remains in the export.
Complete exception descendants are removed after combining RF2, ordinary ECL
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
