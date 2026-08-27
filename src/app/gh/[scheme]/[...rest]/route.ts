import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  sanitizeSetCookie,
  pickUpstreamHeaders,
  parseGithubUrl,
} from '@/lib/github-proxy';
import { rewriteHtml, rewriteCss, rewriteXmlLike } from '@/lib/html-rewrite';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GitHub 流式反向代理(无双斜杠路径形式)
 *
 * 路径格式: /gh/https/github.com/{owner}/{repo}/...
 *
 * 采用 scheme + host/path 两段式路径,路径中不出现 "://",
 * 从而避免被 Web 服务器把双斜杠规范化为单斜杠导致 308 重定向,
 * 保证 curl / wget / git clone 等客户端可直连使用。
 *
 * 额外查询参数(如 git 协议的 service=git-upload-pack)原样转发到上游;
 * 同时支持 GET / POST / HEAD,完整透传 Git 智能 HTTP 协议。
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
]);

/** 页面代理浏览:剥离会阻磗改写页面的安全头 */
const STRIP_RESPONSE_HEADERS = [
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
];

async function handleProxy(
  req: NextRequest,
  ctx: { params: Promise<{ scheme?: string; rest?: string[] }> }
) {
  const { scheme, rest } = await ctx.params;

  // 兼容 /gh/https:/github.com/... 这类已被折叠的历史形式
  const proto = (decodeURIComponent(scheme ?? 'https') || 'https')
    .replace(/:+$/, '')
    .toLowerCase();
  const restPath = (rest ?? [])
    .map((s) => decodeURIComponent(s))
    .join('/')
    .replace(/^\/+/, '');
  const sourceUrl = `${proto}://${restPath}`;

  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return NextResponse.json({ error: '无效的目标地址' }, { status: 400 });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return NextResponse.json({ error: '仅支持 http/https 协议' }, { status: 400 });
  }
  // 域名不设限:任意 http/https 站点均可通过代理访问

  // 转发额外查询参数(git 智能协议需要)
  for (const [k, v] of req.nextUrl.searchParams.entries()) {
    url.searchParams.set(k, v);
  }

  // 挑选需要转发的请求头(过滤逐跳头,避免转发受限头时报错)
  const forwardHeaders: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) {
    if (!HOP_HEADERS.has(k.toLowerCase())) {
      forwardHeaders[k] = v;
    }
  }
  forwardHeaders['user-agent'] =
    'Mozilla/5.0 (compatible; GHFast/1.0; +github-accelerator)';
  forwardHeaders['accept-encoding'] = 'identity';

  const method = req.method === 'HEAD' ? 'HEAD' : req.method;

  try {
    const upstream = await fetch(url.toString(), {
      method,
      headers: forwardHeaders,
      body: method === 'GET' || method === 'HEAD' ? undefined : req.body,
      redirect: 'follow',
      // @ts-expect-error duplex 是 fetch 流式请求所需但未录入 TS 类型
      duplex: 'half',
      cache: 'no-store',
      signal: AbortSignal.timeout(120_000),
    });

    // 重定向跟随后的真实地址(资源可能落在 CDN/子域上),作为改写与记录的基准
    const effectiveUrl = new URL(upstream.url || url.toString());
    const ctEarly = (upstream.headers.get('content-type') ?? '').toLowerCase();

    if (!upstream.ok && upstream.status >= 400 && !ctEarly.includes('text/html')) {
      try {
        await db.downloadRecord.create({
          data: {
            sourceUrl: effectiveUrl.toString(),
            proxyPath: `/gh/${effectiveUrl.protocol.slice(0, -1)}/${effectiveUrl.host}${effectiveUrl.pathname}`,
            type: 'other',
            status: 'error',
          },
        });
      } catch { /* 日志失败不影响响应 */ }

      const detail =
        upstream.status === 404
          ? '文件不存在或仓库为私有'
          : upstream.status === 403
            ? '上游拒绝访问(限流或私有资源)'
            : '上游返回错误';
      return NextResponse.json(
        { error: detail, status: upstream.status },
        { status: upstream.status }
      );
    }
    // 注:text/html 的 404/403/500 等错误页不再吞掉,原样改写后按原状态码回传,
    // 保持网页代理的浏览体验(如 GitHub 的页面指引内链可继续点击)

    const headers = new Headers(pickUpstreamHeaders(upstream.headers));
    headers.set('x-proxied-by', 'GHFast');
    // Set-Cookie 清洗透传(去掉 Domain=/Secure/SameSite=None),登录态可保留在本站域下
    const setCookies = typeof upstream.headers.getSetCookie === 'function'
      ? upstream.headers.getSetCookie()
      : [];
    for (const c of setCookies) {
      headers.append('set-cookie', sanitizeSetCookie(c));
    }

    // 记录下载到数据库(await 保证落库再返回流)
    const parsed = parseGithubUrl(effectiveUrl.toString());
    const sizeHeader = upstream.headers.get('content-length');
    try {
      await db.downloadRecord.create({
        data: {
          sourceUrl: effectiveUrl.toString(),
          proxyPath: `/gh/${effectiveUrl.protocol.slice(0, -1)}/${effectiveUrl.host}${effectiveUrl.pathname}`,
          type: parsed?.type ?? 'other',
          owner: parsed?.owner ?? null,
          repo: parsed?.repo ?? null,
          fileName: parsed?.fileName ?? null,
          sizeBytes: sizeHeader ? BigInt(sizeHeader) : null,
          status: 'ok',
        },
      });
    } catch { /* 记录失败不影响下载 */ }

    // 页面代理浏览:HTML/CSS/manifest/XML 响应做内容改写,让点击/加载行为留在代理内
    // manifest 单独处理:Chrome 解析 Web App Manifest 图标不受任何 JS 钩子约束,必须服务端改写
    const ct = (upstream.headers.get('content-type') ?? '').toLowerCase();
    const isHtml = ct.includes('text/html');
    const isCss = ct.includes('text/css');
    const isManifest = ct.includes('application/manifest') || url.pathname.endsWith('/manifest.json');
    const isXml =
      ct.includes('xml') || /\.(atom|rss|xml)$/.test(url.pathname) === true;
    const declaredLen = Number(upstream.headers.get('content-length') ?? '0');
    const rewriteable =
      upstream.body != null &&
      method !== 'HEAD' &&
      (isHtml || isCss || isManifest || isXml) &&
      (declaredLen === 0 || declaredLen < 10 * 1024 * 1024);

    if (rewriteable) {
      const raw = await upstream.text();
      let rewritten: string;
      if (isHtml) rewritten = rewriteHtml(raw, effectiveUrl);
      else if (isCss) rewritten = rewriteCss(raw, effectiveUrl);
      else if (isManifest) rewritten = rewriteXmlLike(raw);
      else rewritten = rewriteXmlLike(raw); // atom/rss/xml 内容直链改写
      const h = new Headers(headers);
      for (const k of STRIP_RESPONSE_HEADERS) h.delete(k);
      h.delete('content-length');
      return new NextResponse(rewritten, { status: upstream.status, headers: h });
    }

    if (method === 'HEAD') {
      return new NextResponse(null, { status: upstream.status, headers });
    }

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch (err) {
    console.error('[GHFast] upstream error:', url.toString(), err);
    const msg =
      err instanceof Error && err.name === 'TimeoutError'
        ? '连接上游站点超时,请稍后重试'
        : '代理请求失败,目标站点可能暂时不可达';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

export {
  handleProxy as GET,
  handleProxy as POST,
  handleProxy as HEAD,
};
