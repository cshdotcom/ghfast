import { NextRequest, NextResponse } from 'next/server';
import { parseGithubUrl, TYPE_LABELS } from '@/lib/github-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 解析 GitHub 链接并通过 HEAD 请求获取文件元信息 */
export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ valid: false, error: '请求体格式错误' }, { status: 400 });
  }

  const parsed = parseGithubUrl(body.url ?? '');
  if (!parsed) {
    return NextResponse.json({
      valid: false,
      error: '无法识别的链接,请输入合法的 GitHub 地址(github.com / raw.githubusercontent.com / gist)',
    });
  }

  // HEAD 上游探测大小与类型(失败不阻塞分析结果)
  let sizeBytes: number | null = null;
  let contentType = '';
  try {
    const head = await fetch(parsed.sourceUrl, {
      method: 'HEAD',
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; GHFast/1.0; +github-accelerator)',
        'accept-encoding': 'identity',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (head.ok) {
      const len = head.headers.get('content-length');
      sizeBytes = len ? Number(len) : null;
      contentType = head.headers.get('content-type') ?? '';
    }
  } catch {
    // 忽略探测失败
  }

  return NextResponse.json({
    valid: true,
    ...parsed,
    typeLabel: TYPE_LABELS[parsed.type],
    sizeBytes,
    contentType,
  });
}
