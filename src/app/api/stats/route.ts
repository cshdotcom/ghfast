import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 站点统计:总请求数、传输字节数、今日请求、覆盖仓库数 */
export async function GET() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [totalRequests, totalBytesAgg, todayRequests, repoGroups] =
    await Promise.all([
      db.downloadRecord.count(),
      db.downloadRecord.aggregate({
        _sum: { sizeBytes: true },
        where: { status: 'ok', sizeBytes: { not: null } },
      }),
      db.downloadRecord.count({
        where: { createdAt: { gte: startOfDay } },
      }),
      db.downloadRecord.groupBy({
        by: ['owner'],
        where: { owner: { not: null } },
        _count: { owner: true },
      }),
    ]);

  const sum = (totalBytesAgg._sum.sizeBytes ?? 0n) as Prisma.Decimal | bigint;
  const repos = new Set(repoGroups.map((g) => g.owner).filter(Boolean));

  return NextResponse.json({
    totalRequests,
    totalBytes: Number(sum),
    todayRequests,
    reposServed: repos.size,
  });
}
