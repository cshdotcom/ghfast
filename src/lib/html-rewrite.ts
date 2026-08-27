/**
 * GitHub 页面改写器
 *
 * 让通过代理浏览的 GitHub 页面"留在代理内":
 *  1. 属性级改写:href / src / action / srcset 等指向白名单域的链接 → /gh/https/<host>/...
 *  2. 根相对链接:/features → /gh/https/github.com/features
 *  3. <style>、style=""、.css 文件中的 url() 与 @import 改写
 *  4. <script> 块内嵌的绝对地址(XHR/JSON)改写
 *  5. 注入 <base>,让 JS 动态插入的相对链接也落在代理路径下
 */

const WHITELIST_SUFFIXES = [
  'github.com',
  'githubusercontent.com',
  'githubassets.com',
  'github-cloud.s3.amazonaws.com', // Release 资产预览图床(精确主机)
];

const SKIP_PREFIXES = ['data:', 'blob:', 'javascript:', 'mailto:', 'tel:', 'about:', '#'];

function isWhitelistedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return WHITELIST_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
}

/** 单个 URL 值 → 代理路径;不适用时返回 null */
export function toProxyPath(raw: string, base: URL): string | null {
  const v = raw.trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  if (SKIP_PREFIXES.some((p) => lower.startsWith(p))) return null;
  if (lower.startsWith('/gh/')) return null; // 已是代理路径

  try {
    let resolved: URL;
    if (/^https?:\/\//i.test(v)) {
      resolved = new URL(v);
    } else if (v.startsWith('//')) {
      resolved = new URL(`https:${v}`);
    } else {
      resolved = new URL(v, base); // 根相对 / 相对路径,按原始页面地址解析
    }
    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return null;
    if (!isWhitelistedHost(resolved.hostname)) return null;
    const proto = resolved.protocol.replace(':', '');
    return `/gh/${proto}/${resolved.host}${resolved.pathname}${resolved.search}`;
  } catch {
    return null;
  }
}

/* ------------------------------- 正则清单 ------------------------------- */

const ATTR_RE =
  /\s(href|src|action|formaction|poster|data-src|data-href|data-base-href|data-url|srcset|imagesrcset)\s*=\s*(["'])([^"']*)\2/gi;
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);
const STYLE_ATTR_RE = /\sstyle\s*=\s*(["'])([^"']*)\1/gi;
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const IMPORT_RE = /@import\s+(['"])([^'"]+)\1/gi;
/** 白名单域的绝对/协议相对地址(github.com 及全部子域、githubusercontent、githubassets) */
const HOST_RE =
  /(https?:)?\/\/((?:[a-z0-9-]+\.)*(?:github\.com|githubusercontent\.com|githubassets\.com))(?=[/"':;,)?&\s<]|$)/gi;

/* ------------------------------- 改写实现 ------------------------------- */

function mapSrcset(value: string, base: URL): string {
  return value
    .split(',')
    .map((part) => {
      const t = part.trim();
      if (!t) return part;
      const [u, ...rest] = t.split(/\s+/);
      const p = toProxyPath(u, base);
      return p ? [p, ...rest].join(' ') : t;
    })
    .join(', ');
}

function rewriteCssUrls(css: string, base: URL): string {
  return css
    .replace(CSS_URL_RE, (m, q, u) => {
      const p = toProxyPath(u, base);
      return p ? `url(${q}${p}${q})` : m;
    })
    .replace(IMPORT_RE, (m, q, u) => {
      const p = toProxyPath(u, base);
      return p ? `@import ${q}${p}${q}` : m;
    });
}

/** CSS 文件改写(代理返回 text/css 时调用) */
export function rewriteCss(css: string, cssUrl: URL): string {
  return rewriteCssUrls(css, cssUrl).replace(HOST_RE, '/gh/https/$2');
}

/** HTML 页面改写(代理返回 text/html 时调用) */
export function rewriteHtml(html: string, pageUrl: URL): string {
  let out = html;

  // 1) 属性级改写
  out = out.replace(ATTR_RE, (m, attr, quote, value) => {
    if (SRCSET_ATTRS.has(attr.toLowerCase())) {
      return ` ${attr}=${quote}${mapSrcset(value, pageUrl)}${quote}`;
    }
    const p = toProxyPath(value, pageUrl);
    return p ? ` ${attr}=${quote}${p}${quote}` : m;
  });

  // 2) style 属性
  out = out.replace(STYLE_ATTR_RE, (m, q, v) => {
    const rewritten = rewriteCssUrls(v, pageUrl).replace(HOST_RE, '/gh/https/$2');
    return ` style=${q}${rewritten}${q}`;
  });

  // 3) <style> 块
  out = out.replace(STYLE_BLOCK_RE, (m, body) => `<style>${rewriteCss(body, pageUrl)}</style>`);

  // 4) <script> 块内的白名单绝对地址(XHR 端点、内嵌 JSON 链接)
  out = out.replace(SCRIPT_BLOCK_RE, (m, body) => `<script>${body.replace(HOST_RE, '/gh/https/$2')}</script>`);

  // 5) 注入 <base>:JS 动态插入的相对链接按代理路径解析(已有 <base> 则尊重)
  if (!/<base\s/i.test(out)) {
    const pathname = pageUrl.pathname;
    const dir = pathname.endsWith('/') ? pathname : pathname.slice(0, pathname.lastIndexOf('/') + 1) || '/';
    const baseHref = `/gh/https/${pageUrl.host}${dir}`;
    out = out.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n    <base href="${baseHref}">`);
  }

  return out;
}
