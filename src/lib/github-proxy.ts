/**
 * GitHub 加速下载 - 核心代理逻辑
 *
 * 支持:
 *  - Release 资产:    https://github.com/{owner}/{repo}/releases/download/...
 *  - 仓库压缩包:      https://github.com/{owner}/{repo}/archive/...
 *  - Raw 文件:        https://raw.githubusercontent.com/{owner}/{repo}/...
 *  - Gist 文件:       https://gist.githubusercontent.com/{user}/{id}/raw/...
 *  - Codeload 压缩包: https://codeload.github.com/{owner}/{repo}/zip/...
 *  - Git Clone:       https://github.com/{owner}/{repo}(智能 HTTP 协议透传)
 */

export type GithubLinkType =
  | 'release'
  | 'archive'
  | 'raw'
  | 'gist'
  | 'codeload'
  | 'clone';

export interface ParsedGithubUrl {
  /** 归一化后的原始地址(带协议) */
  sourceUrl: string;
  /** 本站代理路径,例如 /gh/https://github.com/o/r/releases/... */
  proxyPath: string;
  type: GithubLinkType;
  owner?: string;
  repo?: string;
  fileName?: string;
}

/** 允许代理的域名后缀白名单(github-cloud 为 Release 资产预览图床,精确主机) */
const ALLOWED_SUFFIXES = [
  'github.com',
  'githubusercontent.com',
  'githubassets.com',
  'github-cloud.s3.amazonaws.com',
];

/** 判断主机名是否在 GitHub 白名单内 */
export function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_SUFFIXES.some(
    (s) => host === s || host.endsWith('.' + s)
  );
}

/** 规范化用户输入 → 可解析的 URL(容错处理) */
export function normalizeInput(raw: string): URL | null {
  let input = raw.trim();
  if (!input) return null;

  // 纯 "owner/repo" 简写 → 视为仓库主分支 zip 包
  if (/^[\w.-]+\/[\w.-]+$/.test(input) && !input.includes('.')) {
    input = `https://github.com/${input}/archive/refs/heads/main.zip`;
  }

  // 缺少协议时自动补全
  if (!/^https?:\/\//i.test(input)) {
    if (/^[\w.-]+\.(com|net|org|io|dev)\//i.test(input) || /^(www\.)?github\.com/i.test(input)) {
      input = 'https://' + input;
    } else {
      return null;
    }
  }

  try {
    const url = new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!isAllowedHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function extractFileName(pathname: string): string | undefined {
  const seg = pathname.split('/').filter(Boolean).pop();
  if (!seg) return undefined;
  // codeload 的文件名形如 owner-repo-branch.zip
  return decodeURIComponent(seg.split('?')[0]) || undefined;
}

/** 解析 GitHub 地址并识别类型 */
export function parseGithubUrl(raw: string): ParsedGithubUrl | null {
  const url = normalizeInput(raw);
  if (!url) return null;

  const sourceUrl = url.toString();
  const parts = url.pathname.split('/').filter(Boolean);
  // 无双斜杠形式,避免被服务器路径规范化(示例: /gh/https/github.com/o/r)
  const proxyPath = `/gh/${url.protocol.slice(0, -1)}/${url.host}${url.pathname}${url.search}`;

  const base = { sourceUrl, proxyPath };
  let host = url.hostname.toLowerCase();

  // raw.githubusercontent.com / gist.githubusercontent.com
  if (host === 'raw.githubusercontent.com' && parts.length >= 3) {
    return {
      ...base,
      type: 'raw',
      owner: parts[0],
      repo: parts[1],
      fileName: extractFileName(url.pathname),
    };
  }
  if (host === 'gist.githubusercontent.com') {
    return { ...base, type: 'gist', fileName: extractFileName(url.pathname) };
  }
  if (host === 'codeload.github.com' && parts.length >= 3) {
    const ext = ['zip', 'tar.gz', 'tar'].find((e) => url.pathname.includes(`/${e}/`)) ?? 'zip';
    return {
      ...base,
      type: 'codeload',
      owner: parts[0],
      repo: parts[1],
      fileName: `${parts[0]}-${parts[1]}.${ext}`,
    };
  }

  // github.com 家族
  if (host === 'github.com' || host.endsWith('.github.com')) {
    if (parts.length < 2) {
      // 根路径或过短路径视为 clone 目标
      return { ...base, type: 'clone', owner: parts[0], repo: parts[1] };
    }
    const [owner, repo] = parts;

    // /releases/download/{tag}/{file}
    if (parts[2] === 'releases' && parts[3] === 'download' && parts.length >= 6) {
      return {
        ...base,
        type: 'release',
        owner,
        repo,
        fileName: extractFileName('/' + parts.slice(5).join('/')),
      };
    }
    // /releases → 最新发布页(整页 HTML),归为 release
    if (parts[2] === 'releases') {
      return { ...base, type: 'release', owner, repo };
    }
    // /archive/refs/tags/v1.0.zip 或 /archive/main.zip
    if (parts[2] === 'archive' && parts.length >= 4) {
      const last = parts[parts.length - 1];
      return {
        ...base,
        type: 'archive',
        owner,
        repo,
        fileName: last?.includes('.')
          ? decodeURIComponent(last)
          : `${repo}-${decodeURIComponent(last)}.zip`,
      };
    }
    // 其余(git clone 智能协议、普通页面等)
    return { ...base, type: 'clone', owner, repo };
  }

  return { ...base, type: 'other', fileName: extractFileName(url.pathname) };
}

export const TYPE_LABELS: Record<GithubLinkType, string> = {
  release: 'Release 资产',
  archive: '仓库压缩包',
  raw: 'Raw 文件',
  gist: 'Gist 片段',
  codeload: 'Codeload 快照',
  clone: 'Git 仓库 / Clone',
};

/** 从 fetch Response 中挑出需要回传给客户端的响应头 */
export function pickUpstreamHeaders(h: Headers): HeadersInit {
  const out: Record<string, string> = {};
  const allow = [
    'content-type',
    'content-length',
    'content-disposition',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'cache-control',
  ];
  for (const key of allow) {
    const v = h.get(key);
    if (v != null) out[key] = v;
  }
  // 防止 header 注入
  for (const [k, v] of Object.entries(out)) {
    if (/[\r\n]/.test(k + v)) delete out[k];
  }
  return out;
}
