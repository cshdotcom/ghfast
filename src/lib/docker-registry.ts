/**
 * Docker Registry 镜像加速 - 核心分派逻辑
 *
 * 用法(docker 客户端直接把本站当作 registry):
 *   docker pull <本站>/library/alpine:latest            → Docker Hub
 *   docker pull <本站>/alpine:latest                    → Docker Hub(自动补 library/)
 *   docker pull <本站>/ghcr.io/owner/repo:tag           → GHCR
 *   docker pull <本站>/quay.io/ns/repo:tag              → Quay
 *   docker pull <本站>/gcr.io/project/img:tag           → GCR
 *   docker pull <本站>/registry.k8s.io/pause:3.9        → Kubernetes
 *   docker pull <本站>/registry.example.com/foo/bar:tag → 任意其他 registry(泛域名分派)
 *
 * 也兼容 daemon.json registry-mirrors 模式:
 *   { "registry-mirrors": ["https://<本站>"] }
 *
 * 认证闭环:ping /v2/ 返回的上游 WWW-Authenticate 中 realm 被改写为本站 /v2/auth,
 * /v2/auth 再把 token 请求转发到真实 auth 端点 —— daemon 全程只感知本站域名。
 */

export interface RegistryTarget {
  /** 上游 registry 域(如 registry-1.docker.io / ghcr.io) */
  host: string;
  /** 归一化后的 repo name(去掉 registry 前缀;docker.io 单段自动补 library/) */
  name: string;
  /** 是否 Docker Hub(需做 scope 的 library/ 归一化) */
  isDockerHub: boolean;
  /** 用户显式书写了 registry 前缀 */
  explicit: boolean;
}

/** 常见 registry 的兜底 auth 信息(上游不可达时构造 challenge 用) */
const DEFAULT_CHALLENGES: Record<string, { realm: string; service: string }> = {
  'registry-1.docker.io': { realm: 'https://auth.docker.io/token', service: 'registry.docker.io' },
  'ghcr.io': { realm: 'https://ghcr.io/token', service: 'ghcr.io' },
  'quay.io': { realm: 'https://quay.io/v2/auth', service: 'quay.io' },
  'registry.k8s.io': { realm: 'https://registry.k8s.io/token', service: 'registry.k8s.io' },
  'k8s.gcr.io': { realm: 'https://registry.k8s.io/token', service: 'k8s.gcr.io' },
  'gcr.io': { realm: 'https://gcr.io/v2/token', service: 'gcr.io' },
  'mcr.microsoft.com': { realm: 'https://mcr.microsoft.com/v2/', service: 'mcr.microsoft.com' },
};

const DOCKER_HUB_HOSTS = new Set(['docker.io', 'registry-1.docker.io', 'index.docker.io']);

const HOST_LIKE_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/** 判断 name 第一段是否为显式 registry 域名 */
function looksLikeHost(seg: string): boolean {
  if (!seg || !seg.includes('.')) return false;
  return HOST_LIKE_RE.test(seg);
}

/**
 * 把 daemon 请求的 repo name 分派到真实 registry。
 * name 已按 "/" 分段(daemon 只发 repo 名):
 *  - 显式域前缀(ghcr.io/xx/yy、gcr.io/p/i、registry.k8s.io/pause 等)→ 对应 registry
 *  - docker.io/library/alpine、registry-1.docker.io/library/alpine → Docker Hub
 *  - 单段(alpine)或多段无域前缀(user/repo)→ Docker Hub,单段补 library/
 */
export function resolveRegistry(name: string): RegistryTarget | null {
  const clean = name.replace(/^\/+|\/+$/g, '');
  if (!clean || /[\s\\]/.test(clean)) return null;
  const segs = clean.split('/').filter(Boolean);
  if (!segs.length) return null;

  const first = segs[0].toLowerCase();
  if (first === 'docker.io' || first === 'registry-1.docker.io' || first === 'index.docker.io') {
    const rest = segs.slice(1).join('/');
    if (!rest) return null;
    return { host: 'registry-1.docker.io', name: normalizeHubName(rest), isDockerHub: true, explicit: true };
  }
  if (looksLikeHost(first) && segs.length >= 2) {
    // 泛域名分派:任何 含点 的第一段都视为 registry 域 → 支持所有 registry
    const host = segs[0].toLowerCase();
    const rest = segs.slice(1).join('/');
    return { host, name: rest, isDockerHub: false, explicit: true };
  }
  // Docker Hub(无显式前缀)
  return { host: 'registry-1.docker.io', name: normalizeHubName(clean), isDockerHub: true, explicit: false };
}

/** Docker Hub 单段 repo(官方镜像)需补 library/ 前缀 */
function normalizeHubName(name: string): string {
  return name.includes('/') ? name : `library/${name}`;
}

/** 兜底 challenge 表查询 */
export function defaultChallenge(host: string): { realm: string; service: string } {
  return DEFAULT_CHALLENGES[host] ?? { realm: `https://${host}/v2/token`, service: host };
}

/** 是否 Docker Hub 家族的 auth 端点(决定 scope 是否做 library/ 归一化) */
function isHubAuthHost(realmHost: string, service: string): boolean {
  const h = realmHost.toLowerCase();
  return (
    DOCKER_HUB_HOSTS.has(h) ||
    h === 'auth.docker.io' ||
    service === 'registry.docker.io'
  );
}

/**
 * 归一化 token scope:Docker Hub 官方镜像(library/ 补全)。
 * daemon 对 <本站>/alpine 发起 pull 时 scope=repository:alpine:pull,
 * 但上游 registry 需要的 scope 是 repository:library/alpine:pull。
 */
export function normalizeScope(scope: string | null, realmHost: string, service: string): string | null {
  if (!scope || !isHubAuthHost(realmHost, service)) return scope;
  return scope
    .split(/\s+/)
    .map((item) => {
      const m = /^repository:([^:]+):(pull|push|\*,\*|\*|pull,push)$/i.exec(item);
      if (!m) return item;
      const repo = m[1];
      if (repo.includes('/')) return item;
      return `repository:library/${repo}:${m[2]}`;
    })
    .join(' ');
}

/**
 * 构造发回 daemon 的 WWW-Authenticate 头值:
 * realm 指向本站 /v2/auth(原 realm 作为参数带回),service/scope 原样保留。
 */
export function buildChallenge(
  requestOrigin: string,
  upstreamRealm: string,
  service: string
): string {
  const realm = `${requestOrigin}/v2/auth?realm=${encodeURIComponent(upstreamRealm)}`;
  return `Bearer realm="${realm}",service="${service}"`;
}

/** 从上游 WWW-Authenticate 头解析 realm / service / scope */
export function parseWwwAuth(header: string | null): { realm?: string; service?: string; scope?: string } {
  if (!header) return {};
  const out: { realm?: string; service?: string; scope?: string } = {};
  const realm = /realm\s*=\s*"([^"]+)"/i.exec(header);
  const service = /service\s*=\s*"?([^",]+)"?/i.exec(header);
  const scope = /scope\s*=\s*"([^"]+)"/i.exec(header);
  if (realm) out.realm = realm[1];
  if (service) out.service = service[1].trim();
  if (scope) out.scope = scope[1];
  return out;
}

/** 构造上游 auth token 请求 URL(拼 service/scope,原 query 保留) */
export function buildAuthUrl(
  realm: string,
  service: string | undefined,
  scope: string | null
): string | null {
  let u: URL;
  try {
    u = new URL(realm);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (service) u.searchParams.set('service', service);
  if (scope) u.searchParams.set('scope', scope);
  return u.toString();
}

/** 标准 registry 401 错误体(daemon 依赖 errors 结构) */
export function registryErrorJson(code: string, message: string, detail?: unknown): string {
  return JSON.stringify({
    errors: [{ code, message, ...(detail !== undefined ? { detail } : {}) }],
  });
}

/* ------------------------------ 用户输入解析 ------------------------------ */

export interface ParsedDockerRef {
  /** 规范化的镜像引用(显式带 registry 前缀) */
  reference: string;
  registryHost: string;
  name: string;
  tag: string;
  digest?: string;
  /** docker pull 应使用的名字(本站域名 + reference) */
  pullCommandHost: string;
}

/**
 * 识别用户输入是否为 Docker 镜像引用(仅处理显式特征,避免与 GitHub owner/repo 简写冲突):
 *  - 显式 registry 前缀:ghcr.io/owner/repo[:tag][@digest]
 *  - docker.io 前缀:docker.io/library/alpine[:tag]
 *  - 单段名(+可选 tag):alpine / alpine:latest / library/nginx:1.25
 */
export function parseDockerReference(raw: string): ParsedDockerRef | null {
  const input = raw.trim().replace(/^docker\s+pull\s+/i, '').replace(/^https?:\/\//, '');
  if (!input) return null;

  // 显式 registry 前缀(docker.io / ghcr.io / 任意域)
  const explicit = /^((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::[0-9]+)?)\/(.+)$/i.exec(input);
  if (explicit) {
    const host = explicit[1].toLowerCase();
    const rest = explicit[2];
    const isHub = host === 'docker.io';
    const m = /^(.+?)(?::([a-z0-9._-]+))?(?:@(sha256:[0-9a-f]{64}))?$/i.exec(rest);
    if (!m) return null;
    const name = isHub ? normalizeHubName(m[1]) : m[1];
    const tag = m[2] ?? 'latest';
    const registryHost = isHub ? 'registry-1.docker.io' : host;
    return {
      reference: `${host}/${name}${m[3] ? `@${m[3]}` : `:${tag}`}`,
      registryHost,
      name,
      tag,
      digest: m[3],
      pullCommandHost: host,
    };
  }

  // 单段名(官方镜像)+ 可选 tag:alpine / alpine:latest / library/nginx:1.25
  const single = /^(library\/)?([a-z0-9_-]+)(?::([a-z0-9._-]+))?(?:@(sha256:[0-9a-f]{64}))?$/i.exec(input);
  if (single && input.includes(':')) {
    const ns = single[1] ?? 'library/';
    const tag = single[3] ?? 'latest';
    return {
      reference: `docker.io/${ns}${single[2]}${single[4] ? `@${single[4]}` : `:${tag}`}`,
      registryHost: 'registry-1.docker.io',
      name: `${ns}${single[2]}`,
      tag,
      digest: single[4],
      pullCommandHost: 'docker.io',
    };
  }
  return null;
}

/** 生成 docker pull 命令(本站域名前缀;Docker Hub 显式补 library/) */
export function buildPullCommand(host: string, ref: ParsedDockerRef): string {
  const isHub = ref.pullCommandHost === 'docker.io';
  const namePart = isHub && !ref.name.startsWith('library/') ? `library/${ref.name}` : ref.name;
  const prefix = isHub ? '' : `${ref.pullCommandHost}/`;
  return `docker pull ${host}/${prefix}${namePart}${ref.digest ? `@${ref.digest}` : `:${ref.tag}`}`;
}
