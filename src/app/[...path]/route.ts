import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 根路径兜底:凡未匹配本站路由(/、/api/*、/gh/*、/_next/*)的路径,
 * 一律 308 重定向到 GitHub 页面代理 /gh/https/github.com/<path>。
 *
 * 作用:通过代理浏览 GitHub 时,页面内的根相对链接(/features)与
 * 前端 JS 发起的根相对请求(fetch('/notifications'))会落到本站域名,
 * 这里把无缝送回代理,保证"整页浏览不跳出"。
 *
 * 使用 308:保留请求方法与请求体(登录等 POST 场景也能继续)。
 * Location 使用相对路径,适配任意反代/预览网关。
 */

async function redirectProxy(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> }
) {
  const { path } = await ctx.params;
  const segments = (path ?? []).map((s) => encodeURIComponent(decodeURIComponent(s)));

  if (segments.length === 0 || segments[0].startsWith('_next')) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  const search = req.nextUrl.search;
  const location = `/gh/https/github.com/${segments.join('/')}${search}`;
  return new NextResponse(null, {
    status: 308,
    headers: { Location: location, 'cache-control': 'no-store' },
  });
}

export {
  redirectProxy as GET,
  redirectProxy as POST,
  redirectProxy as PUT,
  redirectProxy as PATCH,
  redirectProxy as DELETE,
  redirectProxy as HEAD,
};
