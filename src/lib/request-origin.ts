import type { NextRequest } from 'next/server';

/**
 * 以请求头为准还原「对外可访问」的 host / origin。
 *
 * 为什么不能用 req.nextUrl.host / nextUrl.origin:
 *  1. standalone 模式下 Next 会用 HOSTNAME env(默认 0.0.0.0)重写 nextUrl 的 host;
 *  2. 网关(Caddy 等)反代场景,转发到 Next 的 Host 头可能是内网地址;
 *  3. 所有要把「本站地址」拼接给用户用的输出(docker pull 命令、WWW-Authenticate
 *     realm、加速直链展示)都必须以 x-forwarded-host > host > nextUrl.host 为准。
 */
export function resolveRequestOrigin(req: NextRequest): {
  host: string;
  proto: string;
  origin: string;
} {
  const xfHost = req.headers.get('x-forwarded-host');
  const xfProto = req.headers.get('x-forwarded-proto');
  const host =
    xfHost?.split(',')[0]?.trim() || req.headers.get('host') || req.nextUrl.host;
  const proto =
    xfProto?.split(',')[0]?.trim() || req.nextUrl.protocol.replace(/:$/, '') || 'http';
  return { host, proto, origin: `${proto}://${host}` };
}
