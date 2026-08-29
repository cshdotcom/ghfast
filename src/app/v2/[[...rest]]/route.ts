import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { resolveRequestOrigin } from '@/lib/request-origin';
import {
  resolveRegistry,
  buildChallenge,
  parseWwwAuth,
  normalizeScope,
  buildAuthUrl,
  registryErrorJson,
  defaultChallenge,
} from '@/lib/docker-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Docker Registry HTTP API v2 反向代理(镜像加速)
 *
 * 路径形态(docker 客户端把本站当作 registry):
 *   GET  /v2                      → ping,401 + WWW-Authenticate(realm 改写为本站 /v2/auth)
 *   GET  /v2/auth?realm=...       → token 端点,转发真实 auth,scope 做 library/ 归一化
 *   GET  /v2/{name}/manifests/... → 分派真实 registry,透传
 *   GET  /v2/{name}/blobs/...     → 分派真实 registry,流式(支持 Range)
 *
 * {name} 支持 显式 registry 前缀(ghcr.io/o/r、quay.io/o/r、registry.k8s.io/pause、
 * 任意 registry.example.com/o/r)与 Docker Hub(library/alpine 或单段名)。
 *
 * 仅支持 pull(GET/HEAD);push(POST/PUT/PATCH)返回 501。
 */

const HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'content-encoding',
  'set-cookie',
]);

function pickRequestHeaders(req: NextRequest, dropCookie = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) {
    if (HOP_HEADERS.has(k.toLowerCase())) continue;
    if (dropCookie && k.toLowerCase() === 'cookie') continue;
    out[k] = v;
  }
  out['user-agent'] = 'docker/25-GHFast (+registry-mirror)';
  out['accept-encoding'] = 'identity';
  return out;
}

function pickResponseHeaders(h: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of h.entries()) {
    if (HOP_HEADERS.has(k.toLowerCase())) continue;
    out.set(k, v);
  }
  out.set('x-proxied-by', 'GHFast');
  return out;
}

/** 记录镜像拉取 */
async function recordPull(registryHost: string, name: string, refPath: string, size: string | null) {
  try {
    await db.downloadRecord.create({
      data: {
        sourceUrl: `https://${registryHost}/v2/${name}/${refPath}`,
        proxyPath: `/v2/${registryHost}/${name}/${refPath}`,
        type: 'docker',
        owner: registryHost,
        repo: name,
        fileName: name.split('/').pop() ?? name,
        sizeBytes: size ? BigInt(size) : null,
        status: 'ok',
      },
    });
  } catch {
    /* 记录失败不影响响应 */
  }
}

async function handleV2(req: NextRequest, ctx: { params: Promise<{ rest?: string[] }> }) {
  const { rest } = await ctx.params;
  const pathSegs = (rest ?? []).map((s) => decodeURIComponent(s));
  // realm 要回写给 daemon,host 必须以请求头为准:
  // standalone 下 nextUrl.origin 会被 Next 用 HOSTNAME env(默认 0.0.0.0)重写,daemon 无法解析
  const { origin: requestOrigin } = resolveRequestOrigin(req);
  const auth = req.headers.get('authorization');

  /* ---------- ping:GET /v2 ---------- */
  if (pathSegs.length === 0 || (pathSegs.length === 1 && pathSegs[0] === '')) {
    if (auth) {
      // daemon 已带 token → 转发上游验证
      const up = await fetch('https://registry-1.docker.io/v2/', {
        method: 'GET',
        headers: { authorization: auth, 'user-agent': 'docker/25-GHFast' },
        cache: 'no-store',
        signal: AbortSignal.timeout(6_000),
      });
      return new NextResponse(up.body, { status: up.status, headers: pickResponseHeaders(up.headers) });
    }
    // 匿名 ping:透传上游拿真实 challenge(realm 改写为本站 /v2/auth)
    let realm = 'https://auth.docker.io/token';
    let service = 'registry.docker.io';
    try {
      const up = await fetch('https://registry-1.docker.io/v2/', {
        headers: pickRequestHeaders(req, true),
        cache: 'no-store',
        signal: AbortSignal.timeout(6_000),
      });
      const ch = parseWwwAuth(up.headers.get('www-authenticate'));
      if (ch.realm) realm = ch.realm;
      if (ch.service) service = ch.service;
    } catch {
      /* 上游不可达时用默认表 */
    }
    return new NextResponse(registryErrorJson('UNAUTHORIZED', 'authentication required'), {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': buildChallenge(requestOrigin, realm, service),
        'docker-distribution-api-version': 'registry/2.0',
      },
    });
  }

  /* ---------- token 端点:GET /v2/auth?realm=... ---------- */
  if (pathSegs[0] === 'auth' && pathSegs.length === 1) {
    const realmParam = req.nextUrl.searchParams.get('realm');
    const service = req.nextUrl.searchParams.get('service') ?? undefined;
    let scope = req.nextUrl.searchParams.get('scope');
    let authUrl: string | null = null;

    if (realmParam) {
      const realmUrl = new URL(realmParam);
      const normalized = normalizeScope(scope, realmUrl.hostname, service ?? '');
      if (normalized !== scope) scope = normalized;
      authUrl = buildAuthUrl(realmParam, service, scope);
    } else {
      const def = defaultChallenge('registry-1.docker.io');
      authUrl = buildAuthUrl(def.realm, service ?? def.service, normalizeScope(scope, 'auth.docker.io', service ?? 'registry.docker.io'));
    }
    if (!authUrl) {
      return NextResponse.json(registryErrorJson('DENIED', 'invalid auth realm'), { status: 400 });
    }
    const up = await fetch(authUrl, {
      method: 'GET',
      headers: pickRequestHeaders(req), // 保留 Authorization(docker login 的 Basic)
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    const headers = pickResponseHeaders(up.headers);
    const body = await up.text();
    return new NextResponse(body, { status: up.status, headers });
  }

  /* ---------- push 类操作:不支持(加速下载定位) ---------- */
  if (!['GET', 'HEAD'].includes(req.method)) {
    return NextResponse.json(
      registryErrorJson('UNSUPPORTED', 'GHFast 仅支持镜像拉取(pull),不支持 push'),
      { status: 501 }
    );
  }

  /* ---------- /v2/{name}/...:分派真实 registry ---------- */
  // name 的长度未知,需要找到操作段位置:
  //   /v2/{name}/(manifests|blobs|tags|referrers)/...
  // name 可含显式 registry 域前缀(第一段含点)。
  const OPS = new Set(['manifests', 'blobs', 'tags', 'referrers']);
  let opIdx = -1;
  for (let i = pathSegs.length - 1; i >= 1; i--) {
    if (OPS.has(pathSegs[i])) {
      opIdx = i;
      break;
    }
  }
  if (opIdx < 1) {
    return NextResponse.json(
      registryErrorJson('NAME_UNKNOWN', '不支持的 registry API 路径(仅支持 manifests/blobs/tags/referrers)'),
      { status: 404 }
    );
  }
  const name = pathSegs.slice(0, opIdx).join('/');
  const opPath = pathSegs.slice(opIdx).join('/');
  const target = resolveRegistry(name);
  if (!target) {
    return NextResponse.json(registryErrorJson('NAME_INVALID', '无效的镜像名'), { status: 400 });
  }

  const upstreamUrl = `https://${target.host}/v2/${target.name}/${opPath}${req.nextUrl.search}`;
  const headers = pickRequestHeaders(req);
  // token 已按归一化 name 签发(/v2/auth 中 scope 归一化),上游校验通过

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      cache: 'no-store',
      // @ts-expect-error duplex 为流式所需
      duplex: 'half',
      redirect: 'follow',
      signal: AbortSignal.timeout(300_000),
    });
  } catch (err) {
    console.error('[GHFast docker] upstream error:', upstreamUrl, err);
    return NextResponse.json(registryErrorJson('UNAVAILABLE', '上游 registry 不可达'), { status: 502 });
  }

  // blob/manifest 成功才落库(仅 GET,HEAD 探测不入库);401/404 等错误不记录
  if (
    req.method === 'GET' &&
    upstream.ok &&
    (opPath.startsWith('blobs/') || opPath.startsWith('manifests/'))
  ) {
    const refPath = opPath; // manifests/<tag> 或 blobs/<digest>
    await recordPull(target.host, target.name, refPath, upstream.headers.get('content-length'));
  }

  const respHeaders = pickResponseHeaders(upstream.headers);
  // 401 challenge 改写:realm 指向本站 /v2/auth,token 获取也走加速通道
  // (否则 daemon 需直连上游 auth 域,在国内网络下常不可达)
  if (upstream.status === 401) {
    const ch = parseWwwAuth(upstream.headers.get('www-authenticate'));
    if (ch.realm) {
      respHeaders.set(
        'www-authenticate',
        buildChallenge(requestOrigin, ch.realm, ch.service ?? defaultChallenge(target.host).service)
      );
    }
  }
  // blob 支持断点续传
  return new NextResponse(req.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

export {
  handleV2 as GET,
  handleV2 as HEAD,
  handleV2 as POST,
  handleV2 as PUT,
  handleV2 as PATCH,
  handleV2 as DELETE,
};
