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
 * 归一化 token scope:
 *  1. 剥离 daemon 加上的 registry 域前缀:daemon 对 <本站>/ghcr.io/owner/repo 发起 pull 时,
 *     scope=repository:ghcr.io/owner/repo:pull,而真实上游需要 repository:owner/repo:pull;
 *  2. Docker Hub 官方镜像补 library/:repository:alpine:pull → repository:library/alpine:pull。
 */
export function normalizeScope(scope: string | null, realmHost: string, service: string): string | null {
  if (!scope) return scope;
  return scope
    .split(/\s+/)
    .map((item) => {
      const m = /^repository:([^:]+):(pull|push|\*,\*|\*|pull,push)$/i.exec(item);
      if (!m) return item;
      let repo = m[1];
      // 1) 剥离显式 registry 域前缀(首段含点/端口/localhost 视为域)
      if (repo.includes('/')) {
        const first = repo.split('/')[0];
        if (first.includes('.') || first.includes(':') || first.toLowerCase() === 'localhost') {
          repo = repo.slice(first.length + 1);
        }
      }
      // 2) Hub library/ 补全
      if (isHubAuthHost(realmHost, service) && !repo.includes('/')) {
        repo = `library/${repo}`;
      }
      return `repository:${repo}:${m[2]}`;
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
  /** 用户是否显式书写了 registry 域前缀 */
  explicitRegistry: boolean;
  /** 识别置信度:high=无歧义;medium=未知域前缀且无显式 tag(可能与网址歧义) */
  confidence: 'high' | 'medium';
}

/** Docker 镜像 repo 组件约束(官方规则) */
const REPO_COMPONENT_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const TAG_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;
const DIGEST_RE = /^(sha256:[0-9a-f]{64}|sha512:[0-9a-f]{128})$/;

/** 代码托管/网站域名家族 —— 永不判为 Docker 镜像(交给网址代理路径) */
function isWebHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    /(^|\.)github\.com$/.test(h) ||
    /(^|\.)githubusercontent\.com$/.test(h) ||
    /(^|\.)githubassets\.com$/.test(h) ||
    /(^|\.)github\.io$/.test(h) ||
    /(^|\.)gitlab\.com$/.test(h) ||
    /(^|\.)gitee\.com$/.test(h) ||
    /(^|\.)bitbucket\.org$/.test(h)
  );
}

/** 主流 registry 域(判定输入是镜像而非普通网址的强特征) */
const KNOWN_REGISTRIES = new Set([
  'ghcr.io',
  'gcr.io',
  'quay.io',
  'registry.k8s.io',
  'k8s.gcr.io',
  'mcr.microsoft.com',
  'public.ecr.aws',
  'registry.gitlab.com',
  'docker.io',
  'registry-1.docker.io',
  'index.docker.io',
  'nvcr.io',
  'registry.digitalocean.com',
  'docker.cloudsmith.io',
  'mirror.gcr.io',
  'ccr.ccs.tencentyun.com',
]);

/** 是否主流/知名 registry 域(含模式匹配) */
export function isKnownRegistryHost(host: string): boolean {
  const h = host.toLowerCase();
  if (KNOWN_REGISTRIES.has(h)) return true;
  if (/\.gcr\.io$/.test(h) || /\.docker\.io$/.test(h)) return true;
  if (/^registry\.cn-[a-z0-9-]+\.aliyuncs\.com$/.test(h)) return true;
  return false;
}

function validRepoName(name: string): boolean {
  if (!name) return false;
  return name
    .split('/')
    .every((c) => c.length > 0 && REPO_COMPONENT_RE.test(c.toLowerCase()));
}

/**
 * 识别用户输入是否为 Docker 镜像引用。严格模式:
 *  - 带协议(://)或含空格 → 一律不算镜像(交给网址代理)
 *  - GitHub/GitLab 等代码托管域名家族 → 不算镜像
 *  - 显式 registry 前缀:ghcr.io/o/r[:tag][@digest]、docker.io/library/alpine、localhost:5000/img
 *  - Hub 官方镜像:alpine / alpine:latest / library/nginx:1.25(可带 digest)
 *  - Hub 用户镜像:必须显式带 tag 或 digest(user/img:1.0),裸 user/repo 让位给 GitHub 简写
 *  - 未知域前缀且无显式 tag → confidence:'medium'(调用方决定是否让位给网址解析)
 */
export function parseDockerReference(raw: string): ParsedDockerRef | null {
  let input = raw.trim();
  if (!input) return null;
  // "docker pull" / "docker image pull" 前缀剥离
  input = input.replace(/^docker\s+(?:image\s+)?pull\s+/i, '').trim();
  if (!input || /\s/.test(input)) return null;
  // 带协议的 URL 不是镜像
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return null;

  /* 1) digest */
  let digest: string | undefined;
  const at = input.lastIndexOf('@');
  if (at !== -1) {
    const d = input.slice(at + 1).toLowerCase();
    if (!DIGEST_RE.test(d)) return null;
    digest = d;
    input = input.slice(0, at);
    if (!input) return null;
  }

  /* 2) tag:最后一个 "/" 之后的第一个 ":" 才是 tag 分隔(域名端口不受影响) */
  let tag = 'latest';
  let explicitTag = false;
  const lastSlash = input.lastIndexOf('/');
  const colon = input.indexOf(':', lastSlash + 1);
  if (colon !== -1) {
    const t = input.slice(colon + 1);
    if (!TAG_RE.test(t)) return null;
    tag = t;
    explicitTag = true;
    input = input.slice(0, colon);
    if (!input) return null;
  }

  /* 3) 分段 */
  const segs = input.split('/').filter(Boolean);
  if (!segs.length || segs.length > 6) return null;

  const first = segs[0];
  const hostLike =
    first.includes('.') || first.includes(':') || first.toLowerCase() === 'localhost';

  /* 4) 显式 registry 前缀 */
  if (hostLike) {
    const hostOk =
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]+)?$/i.test(first) ||
      /^localhost(:[0-9]+)?$/i.test(first);
    if (!hostOk) return null;
    if (isWebHost(first)) return null; // 代码托管域名 → 交给网址路径
    if (segs.length < 2) return null; // 只有域名没有 repo → 更像网址
    const isHub = /^(docker\.io|registry-1\.docker\.io|index\.docker\.io)$/i.test(first);
    const name = segs.slice(1).join('/').toLowerCase();
    if (!validRepoName(name)) return null;
    const hubName = normalizeHubName(name);
    const host = first.toLowerCase();
    const known = isKnownRegistryHost(host);
    return {
      reference: `${isHub ? 'docker.io' : host}/${isHub ? hubName : name}${digest ? `@${digest}` : `:${tag}`}`,
      registryHost: isHub ? 'registry-1.docker.io' : host,
      name: isHub ? hubName : name,
      tag,
      digest,
      pullCommandHost: isHub ? 'docker.io' : host,
      explicitRegistry: true,
      confidence: known || explicitTag || digest || first.includes(':') ? 'high' : 'medium',
    };
  }

  /* 5) Docker Hub(无显式 registry) */
  const name = segs.join('/').toLowerCase();
  if (!validRepoName(name)) return null;

  // 多段用户镜像:需显式 tag/digest,或 library/ 官方前缀,否则让位给 GitHub owner/repo 简写
  if (segs.length >= 2) {
    const isOfficial = segs[0].toLowerCase() === 'library';
    if (!explicitTag && !digest && !isOfficial) return null;
    return {
      reference: `docker.io/${normalizeHubName(name)}${digest ? `@${digest}` : `:${tag}`}`,
      registryHost: 'registry-1.docker.io',
      name: normalizeHubName(name),
      tag,
      digest,
      pullCommandHost: 'docker.io',
      explicitRegistry: false,
      confidence: 'high',
    };
  }

  // 单段官方镜像(alpine / alpine:latest / @digest)
  return {
    reference: `docker.io/library/${name}${digest ? `@${digest}` : `:${tag}`}`,
    registryHost: 'registry-1.docker.io',
    name: `library/${name}`,
    tag,
    digest,
    pullCommandHost: 'docker.io',
    explicitRegistry: false,
    confidence: 'high',
  };
}

/** 生成 docker pull 命令(本站域名前缀;Docker Hub 显式补 library/) */
export function buildPullCommand(host: string, ref: ParsedDockerRef): string {
  const isHub = ref.pullCommandHost === 'docker.io';
  const namePart = isHub && !ref.name.startsWith('library/') ? `library/${ref.name}` : ref.name;
  const prefix = isHub ? '' : `${ref.pullCommandHost}/`;
  return `docker pull ${host}/${prefix}${namePart}${ref.digest ? `@${ref.digest}` : `:${ref.tag}`}`;
}
