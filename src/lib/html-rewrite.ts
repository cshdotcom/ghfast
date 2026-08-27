/**
 * 网页代理改写器(v3 - 全域名不限 + 资源全量钩住)
 *
 * 服务端改写:
 *  1. 属性级改写:href / src / action / srcset / fallback-src / xlink:href / ping 等
 *     支持 任意域名 的绝对 URL、协议相对 //host/path、根相对 /path、相对路径
 *  2. 通用属性扫一遍:任意属性值若解析为 http(s) 地址同样改写(兜底未枚举到的自定义属性)
 *  3. 剥离 SRI integrity/crossorigin/nonce 与 meta CSP;移除上游 <base>,统一注入本站 <base>
 *  4. <meta http-equiv="refresh"> 的跳转地址改写;<style>/style 属性/CSS 文件 url() 改写
 *  5. <script> 块内嵌绝对地址改写(开标签原样保留,type="application/json" 不被破坏)
 *  6. 注入客户端钩子:fetch / XHR / setAttribute / 元素属性 setter / Worker / EventSource /
 *     history.pushState / sendBeacon / MutationObserver,钩住 JS 动态资源加载与 SPA 导航
 */

/* ------------------------------- 常量 ------------------------------- */

const SKIP_PREFIXES = ['data:', 'blob:', 'javascript:', 'mailto:', 'tel:', 'about:', 'ws:', 'wss:', '#'];

/** 已代理路径前缀(避免二次处理) */
const PROXY_PREFIX = '/gh/';

/* ------------------------------- 正则清单 ------------------------------- */

/** 已知 URL 型属性(tagname 无关,按属性名匹配) */
const ATTR_RE =
  /\s(href|src|action|formaction|poster|background|fallback-src|data-src|data-href|data-base-href|data-url|data-fallback-src|srcset|imagesrcset)\s*=\s*(["'])([^"']*)\2/gi;
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);
const STYLE_ATTR_RE = /\sstyle\s*=\s*(["'])([^"']*)\1/gi;
const STYLE_BLOCK_RE = /(<style\b[^>]*>)([\s\S]*?)<\/style>/gi;
/** 捕获开标签原样保留(关键:type="application/json" 等不能丢!) */
const SCRIPT_BLOCK_RE = /(<script\b[^>]*>)([\s\S]*?)<\/script>/gi;
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const IMPORT_RE = /@import\s+(['"])([^'"]+)\1/gi;
/**
 * 通用绝对地址匹配:https?://any.host 或 //any.host(host 后必须跟 / 才算资源地址)
 * 用于 script 内嵌字符串、CSS 兜底、XML/manifest 内容,任意域名
 */
const GENERIC_URL_RE =
  /(https?:)?\/\/((?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\.)+[a-z]{2,})(?=\/)/gi;

/**
 * 通用属性扫一遍:任意 属性名="值",值整体须能解析为 http(s)/协议相对 地址才改写。
 * 用于覆盖未枚举的自定义属性(如 g-emoji fallback-src、各种 data-* 携带的直链)
 */
const GENERIC_ATTR_RE =
  /\s([a-zA-Z][a-zA-Z0-9_.:[\]-]*)\s*=\s*(["'])([^"'\n<>]{4,2000})\2/g;

const META_CSP_RE = /<meta[^>]+http-equiv\s*=\s*["']content-security-policy["'][^>]*>/gi;
const INTEGRITY_RE = /\s(integrity|crossorigin|nonce)\s*=\s*(["'])[^"']*\2/gi;
const BASE_TAG_RE = /<base\b[^>]*>/gi;
/** xmlns 命名空间保护(XML/Atom 中改写时不能被误伤) */
const XMLNS_MASK_RE = /\s(xmlns|xmlns:[a-zA-Z0-9_-]+)\s*=\s*(["'])([^"']*)\2/gi;
const META_REFRESH_RE =
  /(<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]+content\s*=\s*["'])([^"']+)(["'])/gi;

/* ------------------------------- 工具函数 ------------------------------- */

function skipValue(v: string): boolean {
  if (!v) return true;
  const lower = v.toLowerCase();
  if (SKIP_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (lower.startsWith(PROXY_PREFIX)) return true; // 已是代理相对路径
  return false;
}

/** 单个 URL 值 → 代理路径;不适用时返回 null。任意域名均放行 */
export function toProxyPath(raw: string, base: URL): string | null {
  const v = raw.trim();
  if (skipValue(v)) return null;

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
    const proto = resolved.protocol.replace(':', '');
    return `${PROXY_PREFIX}${proto}/${resolved.host}${resolved.pathname}${resolved.search}`;
  } catch {
    return null;
  }
}

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

function replaceGenericUrls(text: string): string {
  // 兜底替换内嵌字符串里的绝对地址(保留协议语义)
  return text.replace(GENERIC_URL_RE, (m, proto: string | undefined, host: string) => {
    const p = proto && proto.toLowerCase() === 'http:' ? 'http' : 'https';
    return `${PROXY_PREFIX}${p}/${host}`;
  });
}

/** XML / Web App Manifest 内容改写(先摘除 xmlns 命名空间,防止误伤再补回) */
export function rewriteXmlLike(text: string): string {
  const nsStash: string[] = [];
  let out = text.replace(XMLNS_MASK_RE, (m) => {
    nsStash.push(m);
    return `\u0000NS${nsStash.length - 1}\u0000`;
  });
  out = replaceGenericUrls(out);
  out = out.replace(/\u0000NS(\d+)\u0000/g, (_m, i) => nsStash[Number(i)] ?? '');
  return out;
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
  return replaceGenericUrls(rewriteCssUrls(css, cssUrl));
}

/* --------------------------- 客户端钩子脚本 --------------------------- */

interface HookConfig {
  /** 上游源站 origin,如 https://github.com */
  ORIGIN: string;
  /** 上游页面目录路径,如 /login/(根相对链接的解析基准) */
  PATHDIR: string;
}

function buildHookScript(cfg: HookConfig): string {
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `(function(){
'use strict';
var CFG=${json};
var PRE='${PROXY_PREFIX}';
if(window.__ghfastHooked)return;window.__ghfastHooked=1;
var ORIGIN=CFG.ORIGIN||location.protocol+'//'+location.host;
var BASE=ORIGIN+(CFG.PATHDIR||'/');
var SELF_HOST=location.host;
var URL_ATTRS={href:1,src:1,action:1,poster:1,'data-src':1,'data-href':1,'data-url':1,'data-base-href':1,'data-fallback-src':1,'fallback-src':1,formaction:1,ping:1};
function isSkip(s){if(!s)return 1;s=(''+s).trim();if(!s||s.charAt(0)==='#')return 1;if(s.indexOf(PRE)===0)return 1;return /^(data|blob|javascript|mailto|tel|about|ws|wss):/i.test(s);}
window.__ghfastResolve=function(u){
 try{
  var s=(''+u).trim();
  if(isSkip(s))return null;
  var m=/^[a-z][a-z0-9+.\\-]*:/i.exec(s);
  if(m){var p=m[0].toLowerCase();if(p!=='http:'&&p!=='https:')return null;}
  if(s.indexOf('//')===0)s='https:'+s;
  var abs=new URL(s,BASE);
  if(abs.protocol!=='http:'&&abs.protocol!=='https:')return null;
  /* 关键防循环:自站 origin 且路径在 /gh/ 下 → 已是代理地址,拒绝二次前缀 */
  if(abs.host===SELF_HOST&&abs.pathname.slice(0,4)==='/gh/')return null;
  return PRE+abs.protocol.slice(0,-1)+'/'+abs.host+abs.pathname+abs.search;
 }catch(e){return null}
};
function mapSet(v){
 var out=[],ch=false;
 (''+v).split(',').forEach(function(part){
  var t=part.trim();if(!t){out.push(part);return}
  var seg=t.split(/\\s+/),r=seg[0]?window.__ghfastResolve(seg[0]):null;if(r){seg[0]=r;ch=true}
  out.push(seg.join(' '));
 });
 return ch?out.join(', '):null;
}
/* ---- fetch ---- */
var of=window.fetch;
if(of){window.fetch=function(input,init){
 try{
  if(typeof input==='string'){var r=window.__ghfastResolve(input);if(r)return of.call(this,r,init)}
  else if(typeof URL!=='undefined'&&input instanceof URL){var r2=window.__ghfastResolve(''+input);if(r2)return of.call(this,r2,init)}
  else if(input&&input.url){var r3=window.__ghfastResolve(input.url);if(r3&&(!input.bodyUsed)){
   input=new Request(r3,{method:(init&&init.method)||input.method,headers:(init&&init.headers)||input.headers,body:(init&&('body'in init))?init.body:null,credentials:input.credentials,cache:input.cache});
  }}
 }catch(e){}
 return of.apply(this,[input,init]);
}}
/* ---- XMLHttpRequest ---- */
var xo=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(){try{var r=window.__ghfastResolve(arguments[1]);if(r)arguments[1]=r}catch(e){}return xo.apply(this,arguments)};
/* ---- navigator.sendBeacon ---- */
try{var ob=navigator.sendBeacon;if(ob){navigator.sendBeacon=function(u,d){try{var r=window.__ghfastResolve(u);if(r)u=r}catch(e){}return ob.call(navigator,u,d)}}}catch(e){}
/* ---- window.open ---- */
var wo=window.open;
window.open=function(){try{var r=window.__ghfastResolve(arguments[0]);if(r)arguments[0]=r}catch(e){}return wo.apply(this,arguments)};
/* ---- Worker / SharedWorker / EventSource(JS 独立线程内无法钩,须在建链前改址) ---- */
function wrapCtor(Ctor,rebuild){
 if(!Ctor)return;
 var Wrapped=function(){
  try{
   var u=arguments[0];
   if(typeof u==='string'||(typeof URL!=='undefined'&&u instanceof URL)){
    var r=window.__ghfastResolve(typeof u==='string'?u:''+u);
    if(r){var arr=[];for(var i=0;i<arguments.length;i++)arr.push(arguments[i]);arr[0]=r;return rebuild(Ctor,arr)}
   }
  }catch(e){}
  var a2=[];for(var j=0;j<arguments.length;j++)a2.push(arguments[j]);
  return rebuild(Ctor,a2);
 };
 try{Wrapped.prototype=Ctor.prototype}catch(e){}
 return Wrapped;
}
try{window.Worker=wrapCtor(window.Worker,function(C,a){return new C(a[0],a[1])})}catch(e){}
try{window.SharedWorker=wrapCtor(window.SharedWorker,function(C,a){return new C(a[0],a[1])})}catch(e){}
try{window.EventSource=wrapCtor(window.EventSource,function(C,a){return new C(a[0],a[1])})}catch(e){}
/* ---- history.pushState / replaceState(SPA 绝对地址路由落在代理内) ---- */
['pushState','replaceState'].forEach(function(fn){
 try{var orig=history[fn];if(orig){history[fn]=function(){
  try{var u=arguments[2];if(u!=null&&typeof u!=='boolean'){
   var s=u instanceof URL?(''+u):(''+u);
   if(/^https?:\\/\\//i.test(s)||s.indexOf('//')===0){var r=window.__ghfastResolve(s);if(r)arguments[2]=r;}
   else if(s.charAt(0)==='/'&&s.slice(0,4)!==PRE){var oh=ORIGIN.replace(/^https?:\\/\\//,'');arguments[2]=PRE+(ORIGIN.indexOf('https:')===0?'https':'http')+'/'+oh+s;}
  }}catch(e){}
  return orig.apply(history,arguments)}}}catch(e){}
});
/* ---- setAttribute(integrity/crossorigin 强制清空,否则动态 SRI 会拦截已改写资源) ---- */
var sa=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(n,v){
 try{var k=(''+n).toLowerCase();
  if(k==='integrity'||k==='crossorigin'||k==='nonce'){v='';return sa.call(this,n,v)}
  if(k in URL_ATTRS){var r=(k==='srcset'||k==='imagesrcset')?mapSet(v):window.__ghfastResolve(v);if(r!=null)v=r}
 }catch(e){}
 return sa.call(this,n,v);
};
/* ---- 元素属性 setter(src/href/action/poster/data/formAction) ---- */
function patchProp(proto,prop){
 var d=Object.getOwnPropertyDescriptor(proto,prop);
 if(!d||!d.set)return;
 try{Object.defineProperty(proto,prop,{get:d.get,set:function(v){try{var n=null;if(typeof v==='string')n=v;else if(typeof URL!=='undefined'&&v instanceof URL)n=''+v;if(n!=null){var r=window.__ghfastResolve(n);if(r!=null)v=r}}catch(e){}d.set.call(this,v)},configurable:true})}catch(e){}
}
[['HTMLImageElement','src'],['HTMLScriptElement','src'],['HTMLIFrameElement','src'],['HTMLSourceElement','src'],['HTMLEmbedElement','src'],['HTMLMediaElement','src'],['HTMLTrackElement','src'],['HTMLInputElement','src'],['HTMLAnchorElement','href'],['HTMLAreaElement','href'],['HTMLBaseElement','href'],['HTMLLinkElement','href'],['HTMLFormElement','action'],['HTMLObjectElement','data'],['HTMLButtonElement','formAction'],['HTMLInputElement','formAction']].forEach(function(e){
 var C=window[e[0]];if(C&&C.prototype)patchProp(C.prototype,e[1]);
});
/* ---- 静态扫描 DOM 树兜底(MutationObserver 之外的首轮清扫) ---- */
function fixNode(el){
 if(!el||el.nodeType!==1)return;
 try{
  if(el.hasAttribute){
   /* 动态注入的 SRI 一律移除 */
   ['integrity','crossorigin','nonce'].forEach(function(b){try{if(el.hasAttribute(b))el.removeAttribute(b)}catch(e){}});
   ['href','src','action','poster','data-src','data-href','data-url','data-base-href','data-fallback-src','fallback-src','formaction'].forEach(function(a){
    if(el.hasAttribute(a)){var v=el.getAttribute(a);if(typeof v==='string'&&v&&!isSkip(v)){var r=window.__ghfastResolve(v);if(r&&r!==v)sa.call(el,a,r)}}
   });
   if(el.hasAttribute('srcset')){var sv=el.getAttribute('srcset');var ms=sv?mapSet(sv):null;if(ms&&ms!==sv)sa.call(el,'srcset',ms)}
  }
 }catch(e){}
}
new MutationObserver(function(muts){
 muts.forEach(function(m){
  if(m.type==='attributes'&&m.target&&m.target.nodeType===1){fixNode(m.target);return}
  m.addedNodes.forEach(function(nd){
   if(nd.nodeType!==1)return;
   fixNode(nd);
   try{nd.querySelectorAll('[href],[src],[action],[poster],[data-src],[data-href],[data-url],[data-base-href],[data-fallback-src],[fallback-src],[formaction],[srcset]').forEach(fixNode)}catch(e){}
  });
 });
}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['href','src','action','poster','data-src','data-href','data-url','data-base-href','data-fallback-src','fallback-src','formaction','srcset']});
})();`;
}

/* ------------------------------- HTML 改写 ------------------------------- */

/** HTML 页面改写(代理返回 text/html 时调用)。pageUrl 应为最终生效地址(重定向后) */
export function rewriteHtml(html: string, pageUrl: URL): string {
  let out = html;

  // 0) 移除内联 CSP meta / SRI / 上游 <base>(改为强制注入本站 base)/ meta refresh 地址
  out = out.replace(META_CSP_RE, '').replace(INTEGRITY_RE, '');
  out = out.replace(BASE_TAG_RE, '');
  out = out.replace(META_REFRESH_RE, (m, head: string, content: string, tail: string) => {
    const mr = /^\s*\d+\s*;\s*url\s*=\s*(.+)$/i.exec(content);
    if (!mr) return m;
    const target = mr[1].trim().replace(/["']/g, '');
    const p = toProxyPath(target, pageUrl);
    return p ? `${head}${content.replace(target.trim(), p)}${tail}` : m;
  });

  // 1) 已知 URL 型属性改写(script 开标签也会被覆盖到)
  out = out.replace(ATTR_RE, (m, attr, quote, value) => {
    if (SRCSET_ATTRS.has(attr.toLowerCase())) {
      return ` ${attr}=${quote}${mapSrcset(value, pageUrl)}${quote}`;
    }
    const p = toProxyPath(value, pageUrl);
    return p ? ` ${attr}=${quote}${p}${quote}` : m;
  });

  // 2) style 属性 与 <style> 块
  out = out.replace(STYLE_ATTR_RE, (m, q, v) => {
    const rewritten = replaceGenericUrls(rewriteCssUrls(v, pageUrl));
    return ` style=${q}${rewritten}${q}`;
  });
  out = out.replace(STYLE_BLOCK_RE, (_m, openTag: string, body: string) => `${openTag}${rewriteCss(body, pageUrl)}</style>`);

  // 3) <script> 块体先用占位符隔离(体内走通用绝对地址替换),
  //    防止随后的「任意属性扫一遍」误伤 JS 字符串语法 —— 开标签属性已被第 1 步改写
  const scriptStash: string[] = [];
  out = out.replace(SCRIPT_BLOCK_RE, (_m, openTag: string, body: string) => {
    const idx = scriptStash.push(
      body.replace(GENERIC_URL_RE, (_mm, proto: string | undefined, host: string) => {
        const p = proto && proto.toLowerCase() === 'http:' ? 'http' : 'https';
        return `${PROXY_PREFIX}${p}/${host}`;
      })
    ) - 1;
    return `${openTag}\u0000GHFAST_SCRIPT_${idx}\u0000</script>`;
  });

  // 4) 通用属性扫一遍:任意属性值若整体为可解析的 http(s)/协议相对地址则改写
  //    (覆盖 fallback-src、data-* 直链等未枚举自定义属性);xmlns 命名空间除外
  out = out.replace(GENERIC_ATTR_RE, (m, name: string, quote: string, value: string) => {
    const lowerName = name.toLowerCase();
    if (lowerName === 'xmlns' || lowerName.startsWith('xmlns:')) return m;
    if (/^(on[a-z]+)$/i.test(lowerName)) return m; // 事件处理器交给客户端钩子
    if (/^(https?:\/\/|\/\/)/.test(value) === false) return m;
    if (value.indexOf(PROXY_PREFIX) !== -1) return m; // 含本站前缀的不再处理
    const p = toProxyPath(value, pageUrl);
    return p ? ` ${name}=${quote}${p}${quote}` : m;
  });

  // 5) 还原 script 体
  out = out.replace(/\u0000GHFAST_SCRIPT_(\d+)\u0000/g, (_m, i: string) =>
    scriptStash[Number(i)] ?? ''
  );

  // 6) 注入客户端钩子脚本(需在所有站点脚本之前执行)+ 本站 <base>
  const dirPath = pageUrl.pathname.endsWith('/')
    ? pageUrl.pathname
    : pageUrl.pathname.slice(0, pageUrl.pathname.lastIndexOf('/') + 1) || '/';
  const hook = `<script>window.__GHFAST=${JSON.stringify({
    ORIGIN: pageUrl.origin,
    PATHDIR: dirPath,
  }).replace(/</g, '\\u003c')};${buildHookScript({
    ORIGIN: pageUrl.origin,
    PATHDIR: dirPath,
  })}</script>`;
  const baseHref = `${PROXY_PREFIX}${pageUrl.protocol.slice(0, -1)}/${pageUrl.host}${dirPath}`;

  const headOpenRe = /<head(\s[^>]*)?>/i;
  if (headOpenRe.test(out)) {
    out = out.replace(headOpenRe, (m) => `${m}\n${hook}\n<base href="${baseHref}">`);
  } else if (/<html(\s[^>]*)?>/i.test(out)) {
    out = out.replace(/<html(\s[^>]*)?>/i, (m) => `${m}\n<head>${hook}\n<base href="${baseHref}"></head>`);
  } else {
    out = `<head><base href="${baseHref}"></head>${out}`;
  }

  return out;
}
