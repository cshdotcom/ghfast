import fs from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';

/**
 * 以请求头为准还原「对外可访问」的 host / origin。
 *
 * 优先级:
 *  1. GHFAST_PUBLIC_ORIGIN 环境变量(显式配置,最高优先):
 *     阿里云 FC / 部分 Serverless 平台会把 Host 头改写成内部触发器域名
 *     (如 *.cn-hongkong-vpc.fcapp.run),反代层也可能不回传 X-Forwarded-Host,
 *     此时唯一可靠手段是部署时显式配置,如 GHFAST_PUBLIC_ORIGIN=https://ghft.example.com
 *  2. db/ghfast.config.json 的 publicOrigin 字段(配置文件兜底):
 *     部署平台无法注入环境变量时,可在应用 db 目录放置
 *     { "publicOrigin": "https://ghft.example.com" }
 *  3. x-forwarded-host(网关/CDN 标准头)
 *  4. host 头
 *  5. nextUrl.host(最后兜底;standalone 下会被 HOSTNAME env(默认 0.0.0.0)重写,
 *     仅本机直连场景可用)
 *
 * 所有要把「本站地址」拼接给用户用的输出(docker pull 命令、WWW-Authenticate
 * realm、加速直链展示)都必须走这里。
 */

/** 配置文件兜底(进程内缓存;Serverless 实例只读一次) */
let configOrigin: string | null | undefined;
function readConfigOrigin(): string | null {
  if (configOrigin !== undefined) return configOrigin;
  configOrigin = null;
  try {
    const file = path.join(process.cwd(), 'db', 'ghfast.config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { publicOrigin?: string };
    if (typeof raw.publicOrigin === 'string' && raw.publicOrigin.trim()) {
      configOrigin = raw.publicOrigin.trim();
    }
  } catch {
    /* 无配置文件或格式非法 → 静默回退请求头推断 */
  }
  return configOrigin;
}

export function resolveRequestOrigin(req: NextRequest): {
  host: string;
  proto: string;
  origin: string;
} {
  const from = (configured: string): { host: string; proto: string; origin: string } | null => {
    try {
      const u = new URL(configured);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return { host: u.host, proto: u.protocol.replace(/:$/, ''), origin: u.origin };
    } catch {
      return null;
    }
  };

  const env = process.env.GHFAST_PUBLIC_ORIGIN?.trim();
  if (env) {
    const hit = from(env);
    if (hit) return hit;
  }
  const file = readConfigOrigin();
  if (file) {
    const hit = from(file);
    if (hit) return hit;
  }

  const xfHost = req.headers.get('x-forwarded-host');
  const xfProto = req.headers.get('x-forwarded-proto');
  const host =
    xfHost?.split(',')[0]?.trim() || req.headers.get('host') || req.nextUrl.host;
  const proto =
    xfProto?.split(',')[0]?.trim() || req.nextUrl.protocol.replace(/:$/, '') || 'http';
  return { host, proto, origin: `${proto}://${host}` };
}
