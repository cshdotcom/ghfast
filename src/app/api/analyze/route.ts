import { NextRequest, NextResponse } from 'next/server';
import { parseGithubUrl, TYPE_LABELS } from '@/lib/github-proxy';
import { resolveRequestOrigin } from '@/lib/request-origin';
import {
  parseDockerReference,
  buildPullCommand,
  type ParsedDockerRef,
} from '@/lib/docker-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Docker 识别结果 → 响应体 */
function dockerResponse(docker: ParsedDockerRef, host: string) {
  const pullCmd = buildPullCommand(host, docker);
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

/** 解析输入(GitHub 链接 / Docker 镜像引用)并尽力探测元信息 */
export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ valid: false, error: '请求体格式错误' }, { status: 400 });
  }

  const value = (body.url ?? '').trim();
  // 拼接 docker 部署地址必须以对外 host 为准:
  // nextUrl.host 在网关/standalone 下可能是 localhost:3000 / 0.0.0.0,拼出来的 pull 命令用户无法使用
  const { host } = resolveRequestOrigin(req);
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);

  /* -------- 识别顺序 --------
   * 1. 带协议 → 一定是网址:GitHub 家族 → GitHub;其余 → 任意站代理
   * 2. 无协议 → 先严格尝试 Docker(库内已排除网址/代码托管域名);
   *    confidence=medium(未知域前缀且无显式 tag)时让位给网址解析,解析失败再兜底 Docker
   */
  if (!hasScheme) {
    const docker = parseDockerReference(value);
    if (docker && docker.confidence === 'high') {
      return dockerResponse(docker, host);
    }
    const parsed = parseGithubUrl(value);
    if (parsed) {
      return await githubResponse(parsed, value);
    }
    if (docker) {
      return dockerResponse(docker, host);
    }
    return NextResponse.json({
      valid: false,
      error: '无法识别的输入。支持:GitHub 地址(github.com / raw / gist)、任意网址、Docker 镜像名(nginx / alpine:latest / user/img:tag / ghcr.io/owner/repo:tag)',
    });
  }

  // 带协议:纯网址路径
  const parsed = parseGithubUrl(value);
  if (!parsed) {
    return NextResponse.json({
      valid: false,
      error: '无效的网址。支持 GitHub 系链接与任意 http/https 站点',
    });
  }
  return await githubResponse(parsed, value);
}

/** GitHub/网址解析结果 → 探测大小与类型后返回(HEAD 失败不阻塞) */
async function githubResponse(
  parsed: NonNullable<ReturnType<typeof parseGithubUrl>>,
  _value: string
) {
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
