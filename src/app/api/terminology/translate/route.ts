import { NextRequest, NextResponse } from 'next/server';
import { TranslateCodesRequest, TranslateCodesResponse } from '@/lib/types';
import { batchTranslateEmisCodes } from '@/lib/terminology-client';

export async function POST(request: NextRequest) {
  try {
    const body: TranslateCodesRequest = await request.json();
    const { codes, equivalenceFilter } = body;

    if (!codes || codes.length === 0) {
      return NextResponse.json<TranslateCodesResponse>(
        { success: false, error: 'No codes provided' },
        { status: 400 }
      );
    }

    const uniqueCodes = [...new Set(codes)];
    console.log(`Batch translating ${uniqueCodes.length} unique EMIS codes (filter: ${equivalenceFilter})...`);

    const equivalences: Record<string, string> = {};
    const translations = await batchTranslateEmisCodes(uniqueCodes, equivalenceFilter, equivalences);

    const successCount = Object.values(translations).filter(t => t !== null).length;
    console.log(`Translation complete: ${successCount}/${uniqueCodes.length} successful`);

    return NextResponse.json<TranslateCodesResponse>({
      success: true,
      translations,
      equivalences,
    });
  } catch (error) {
    console.error('Translation error:', error);
    return NextResponse.json<TranslateCodesResponse>(
      { success: false, error: error instanceof Error ? error.message : 'Translation failed' },
      { status: 500 }
    );
  }
}

export const maxDuration = 300;
