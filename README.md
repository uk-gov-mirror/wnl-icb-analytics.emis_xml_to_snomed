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

### Criterion rendering

Value sets within one filter are joined with OR. Separate filters are joined
with AND, including filters on the same column. Status and prescription type
remain separate filters. When code lists share a column, one record must match
all those filters, so lists with no overlap select no records.

Filters select candidate records first. A restriction then keeps the latest or
earliest N records in its stated order and applies its test to the kept records.
For N greater than 1, at least one kept record must meet the test. Date wording
distinguishes strict bounds from inclusive bounds and retains the search-date
upper bound.

#### Known gaps

Library-item filters within list-report columns are not parsed, so their
same-column conjunctions are not shown or flagged. Guides omit excluded codes
inside filters. Some reused `_vsN` names refer to different code lists within
one report; use the source value-set IDs to distinguish them.

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
