import { NextRequest, NextResponse } from 'next/server';
import { EmisConstituentsRequest, EmisConstituentsResponse } from '@/lib/types';
import { findEmisConstituentSubstances } from '@/lib/terminology-client';

/** Returns the substances that have their own EMIS constituent code. */
export async function POST(request: NextRequest) {
  try {
    const { substanceCodes }: EmisConstituentsRequest = await request.json();
    if (!Array.isArray(substanceCodes) || substanceCodes.length > 1000) {
      return NextResponse.json<EmisConstituentsResponse>({ success: false, error: 'Provide up to 1000 substance codes' }, { status: 400 });
    }
    return NextResponse.json<EmisConstituentsResponse>({ success: true, substanceCodes: await findEmisConstituentSubstances(substanceCodes) });
  } catch (error) {
    console.error('EMIS constituent lookup error:', error);
    return NextResponse.json<EmisConstituentsResponse>(
      { success: false, error: error instanceof Error ? error.message : 'Lookup failed' },
      { status: 500 }
    );
  }
}

export const maxDuration = 300;
