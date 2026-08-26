import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 最近加速下载记录 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, 100);

  const records = await db.downloadRecord.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  // BigInt 无法直接 JSON 序列化,转 Number(<2^53 安全)
  const data = records.map((r) => ({
    ...r,
    sizeBytes: r.sizeBytes != null ? Number(r.sizeBytes) : null,
  }));

  return NextResponse.json({ records: data });
}
