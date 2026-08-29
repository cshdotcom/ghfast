import { NextRequest, NextResponse } from 'next/server';
import { parseGithubUrl, TYPE_LABELS } from '@/lib/github-proxy';
import { parseDockerReference, buildPullCommand } from '@/lib/docker-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 解析输入(GitHub 链接 / Docker 镜像引用)并尽力探测元信息 */
export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ valid: false, error: '请求体格式错误' }, { status: 400 });
  }

  /* -------- Docker 镜像引用优先识别 -------- */
  const docker = parseDockerReference(body.url ?? '');
  if (docker) {
    const pullCmd = buildPullCommand(req.nextUrl.host, docker);
    return NextResponse.json({
      valid: true,
      type: 'docker',
      typeLabel: TYPE_LABELS.docker,
      sourceUrl: `docker://${docker.pullCommandHost}/${docker.name}:${docker.tag}`,
      proxyPath: `/v2/${docker.pullCommandHost === 'docker.io' ? '' : `${docker.pullCommandHost}/`}${docker.name}:${docker.tag}`,
      owner: docker.registryHost,
      repo: docker.name,
      fileName: docker.name.split('/').pop() ?? docker.name,
      sizeBytes: null,
      contentType: 'docker/image',
      docker: {
        image: docker.name,
        tag: docker.tag,
        digest: docker.digest ?? null,
        registryHost: docker.registryHost,
        pullCommand: pullCmd,
      },
    });
  }

  const parsed = parseGithubUrl(body.url ?? '');
  if (!parsed) {
    return NextResponse.json({
      valid: false,
      error: '无法识别的输入。支持:GitHub 地址(github.com / raw / gist)、任意网址、Docker 镜像名(alpine:latest / ghcr.io/owner/repo:tag)',
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
