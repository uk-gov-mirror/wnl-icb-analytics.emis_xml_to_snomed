import { NextRequest, NextResponse } from 'next/server';
import { resolveExceptions } from '@/lib/exception-resolver';
import { findPreparationCandidates, findInactivePreparationCandidates, classifyExceptionTarget, expandEclQuery } from '@/lib/terminology-client';

export async function POST(request: NextRequest) {
  try {
    const { exceptions, translations, historical, codeSystem } = await request.json();
    if (!Array.isArray(exceptions) || exceptions.length > 200) {
      return NextResponse.json({ success: false, error: 'Provide at most 200 exceptions' }, { status: 400 });
    }
    const resolutions = await resolveExceptions(exceptions, translations || {}, historical || {}, findPreparationCandidates, findInactivePreparationCandidates, undefined, { codeSystem, classifyTarget: classifyExceptionTarget, findExactTarget: expandEclQuery });
    return NextResponse.json({ success: true, resolutions });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Exception resolution failed' }, { status: 500 });
  }
}

export const maxDuration = 300;
