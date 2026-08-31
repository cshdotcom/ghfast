import type { NextRequest } from 'next/server';

/**
 * 以请求头为准还原「对外可访问」的 host / origin。
 *
 * 优先级:
 *  1. GHFAST_PUBLIC_ORIGIN 环境变量(显式配置,最高优先):
 *     阿里云 FC / 部分 Serverless 平台会把 Host 头改写成内部触发器域名
 *     (如 *.cn-hongkong-vpc.fcapp.run),反代层也可能不回传 X-Forwarded-Host,
 *     此时唯一可靠手段是部署时显式配置,如 GHFAST_PUBLIC_ORIGIN=https://ghft.example.com
 *  2. x-forwarded-host(网关/CDN 标准头)
 *  3. host 头
 *  4. nextUrl.host(最后兜底;standalone 下会被 HOSTNAME env(默认 0.0.0.0)重写,
 *     仅本机直连场景可用)
 *
 * 所有要把「本站地址」拼接给用户用的输出(docker pull 命令、WWW-Authenticate
 * realm、加速直链展示)都必须走这里。
 */
export function resolveRequestOrigin(req: NextRequest): {
  host: string;
  proto: string;
  origin: string;
} {
  const configured = process.env.GHFAST_PUBLIC_ORIGIN?.trim();
  if (configured) {
    try {
      const u = new URL(configured);
      return { host: u.host, proto: u.protocol.replace(/:$/, ''), origin: u.origin };
    } catch {
      /* 配置非法则忽略,继续走请求头推断 */
    }
  }
  const xfHost = req.headers.get('x-forwarded-host');
  const xfProto = req.headers.get('x-forwarded-proto');
  const host =
    xfHost?.split(',')[0]?.trim() || req.headers.get('host') || req.nextUrl.host;
  const proto =
    xfProto?.split(',')[0]?.trim() || req.nextUrl.protocol.replace(/:$/, '') || 'http';
  return { host, proto, origin: `${proto}://${host}` };
}
