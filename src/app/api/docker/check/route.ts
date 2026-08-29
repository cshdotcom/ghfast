import { NextRequest, NextResponse } from 'next/server';
import {
  parseDockerReference,
  resolveRegistry,
  parseWwwAuth,
  buildAuthUrl,
  defaultChallenge,
} from '@/lib/docker-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Docker 镜像实时检测
 *
 * POST { image: string }  —— 任意可识别的镜像引用(nginx / nginx:1.27 /
 * ghcr.io/owner/repo:tag / docker pull nginx 等)
 *
 * 直连上游 registry 走标准 token 流程 GET manifest,返回:
 *  - exists    true/false/null(null=上游不可达等临时故障)
 *  - digest    docker-content-digest(可拼不可变 pull 命令)
 *  - variants  多架构清单数量(OCI index / manifest list)
 *  - platforms os/arch 去重列表(最多 8 个)
 *
 * 检测不入库,不影响下载统计。
 */

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.v1+prettyjws',
  'application/json',
].join(', ');

interface TokenResponse {
  token?: string;
  access_token?: string;
}

/** 按上游 WWW-Authenticate challenge 获取匿名 pull token */
async function bearerToken(
  host: string,
  repo: string,
  challenge: { realm?: string; service?: string }
): Promise<string | null> {
  const def = defaultChallenge(host);
  const url = buildAuthUrl(
    challenge.realm ?? def.realm,
    challenge.service ?? def.service,
    `repository:${repo}:pull`
  );
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'GHFast/1.0 (+docker-check)', accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as TokenResponse;
    return data.token ?? data.access_token ?? null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  let body: { image?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ exists: false, error: '请求体格式错误' }, { status: 400 });
  }

  const ref = parseDockerReference((body.image ?? '').trim());
  if (!ref) {
    return NextResponse.json(
      { exists: false, error: '无法解析为 Docker 镜像引用(示例:nginx:1.27、ghcr.io/owner/repo:tag)' },
      { status: 400 }
    );
  }
  const target = resolveRegistry(`${ref.pullCommandHost}/${ref.name}`);
  if (!target) {
    return NextResponse.json({ exists: false, error: '无效的镜像名' }, { status: 400 });
  }

  const refPart = ref.digest ?? ref.tag;
  const manifestUrl = `https://${target.host}/v2/${target.name}/manifests/${refPart}`;
  const baseHeaders: Record<string, string> = {
    accept: MANIFEST_ACCEPT,
    'user-agent': 'docker/25-GHFast (+GHFast-check)',
    'accept-encoding': 'identity',
  };

  let res: Response;
  try {
    res = await fetch(manifestUrl, {
      headers: baseHeaders,
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    // 标准流程:401 → 解析 challenge → 匿名 token → 重试
    if (res.status === 401) {
      const token = await bearerToken(
        target.host,
        target.name,
        parseWwwAuth(res.headers.get('www-authenticate'))
      );
      if (token) {
        res = await fetch(manifestUrl, {
          headers: { ...baseHeaders, authorization: `Bearer ${token}` },
          redirect: 'follow',
          cache: 'no-store',
          signal: AbortSignal.timeout(20_000),
        });
      }
    }
  } catch {
    return NextResponse.json({ exists: null, error: '上游 registry 暂时不可达,请稍后再试' });
  }

  const displayRef = `${ref.pullCommandHost}/${ref.name}${ref.digest ? `@${ref.digest}` : `:${ref.tag}`}`;
  if (res.status === 404) {
    return NextResponse.json({
      exists: false,
      error: `镜像或 tag 不存在(上游 404):${displayRef}`,
    });
  }
  if (res.status === 401 || res.status === 403) {
    return NextResponse.json({
      exists: false,
      error: `该镜像为私有仓库,需要登录凭据;加速站仅支持公开镜像拉取:${displayRef}`,
    });
  }
  if (res.status === 429) {
    return NextResponse.json({ exists: null, error: '上游限流(HTTP 429),请稍后再试' });
  }
  if (!res.ok) {
    return NextResponse.json({ exists: null, error: `上游异常(HTTP ${res.status})` });
  }

  const digest = res.headers.get('docker-content-digest') ?? ref.digest ?? null;

  let mediaType = '';
  let variants = 0;
  let platforms: string[] = [];
  try {
    const manifest = (await res.json()) as {
      mediaType?: string;
      manifests?: { platform?: { os?: string; architecture?: string } }[];
    };
    mediaType = manifest.mediaType ?? '';
    if (Array.isArray(manifest.manifests)) {
      variants = manifest.manifests.length;
      const set = new Set<string>();
      for (const m of manifest.manifests) {
        const p = m.platform;
        if (p?.os && p?.architecture) set.add(`${p.os}/${p.architecture}`);
      }
      platforms = [...set].slice(0, 8);
    }
  } catch {
    /* 单架构 manifest body 可能非 JSON,忽略 */
  }

  return NextResponse.json({
    exists: true,
    digest,
    mediaType: mediaType || null,
    variants,
    platforms,
    reference: ref.reference,
    name: ref.name,
    tag: ref.tag,
    registryHost: ref.registryHost,
  });
}
