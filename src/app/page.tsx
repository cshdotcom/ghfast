'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Braces,
  Check,
  Copy,
  Download,
  FileText,
  Github,
  GitBranch,
  Globe,
  History,
  Link2,
  Loader2,
  Package,
  ShieldCheck,
  Terminal,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/* ---------------------------------- 类型 ---------------------------------- */

interface AnalyzeResult {
  valid: boolean;
  error?: string;
  sourceUrl?: string;
  proxyPath?: string;
  type?: string;
  typeLabel?: string;
  owner?: string;
  repo?: string;
  fileName?: string;
  sizeBytes?: number | null;
  contentType?: string;
}

interface HistoryRecord {
  id: string;
  sourceUrl: string;
  proxyPath: string;
  type: string;
  owner: string | null;
  repo: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  status: string;
  createdAt: string;
}

interface Stats {
  totalRequests: number;
  totalBytes: number;
  todayRequests: number;
  reposServed: number;
}

const TYPE_ICONS: Record<string, React.ElementType> = {
  release: Package,
  archive: Archive,
  raw: FileText,
  gist: Braces,
  codeload: Archive,
  clone: GitBranch,
  other: Globe,
};

const TYPE_BADGE_STYLES: Record<string, string> = {
  release: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  archive: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  raw: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  gist: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30',
  codeload: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  clone: 'bg-teal-500/15 text-teal-300 border-teal-500/30',
  other: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
};

const EXAMPLES = [
  {
    label: 'Release 文件',
    icon: Package,
    url: 'https://github.com/PowerShell/PowerShell/releases/download/v7.4.6/PowerShell-7.4.6-win-x64.msi',
  },
  {
    label: '仓库压缩包',
    icon: Archive,
    url: 'https://github.com/microsoft/vscode/archive/refs/heads/main.zip',
  },
  {
    label: 'Raw 文件',
    icon: FileText,
    url: 'https://raw.githubusercontent.com/torvalds/linux/master/README',
  },
  {
    label: '网页代理 · 任意站',
    icon: Globe,
    url: 'https://github.com/login',
  },
];

/* --------------------------------- 工具函数 -------------------------------- */

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

async function copyText(text: string, tip = '已复制到剪贴板') {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(tip);
  } catch {
    toast.error('复制失败,请手动复制');
  }
}

/* ---------------------------------- 页面 ---------------------------------- */

export default function HomePage() {
  const [input, setInput] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [downloaded, setDownloaded] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const proxyFullUrl = useMemo(() => {
    if (!result?.valid || !result.sourceUrl) return '';
    return `${origin}/gh/${result.sourceUrl}`;
  }, [result, origin]);

  const refreshData = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        fetch('/api/stats').then((r) => r.json()),
        fetch('/api/history?limit=20').then((r) => r.json()),
      ]);
      setStats(s);
      setHistory(h.records ?? []);
    } catch {
      /* 静默失败 */
    }
  }, []);

  const analyze = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value) {
      setResult(null);
      return;
    }
    setAnalyzing(true);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: value }),
      });
      const data: AnalyzeResult = await res.json();
      setResult(data);
      if (!data.valid && data.error) toast.warning(data.error);
    } catch {
      setResult({ valid: false, error: '分析服务暂时不可用' });
    } finally {
      setAnalyzing(false);
    }
  }, []);

  // 输入防抖自动解析
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      analyze(input);
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [input, analyze]);

  useEffect(() => {
    refreshData();
  }, [refreshData]);

  const handleDownload = () => {
    if (!proxyFullUrl || !result?.valid) return;
    const a = document.createElement('a');
    a.href = proxyFullUrl;
    // 同源 + download 属性:无论上游 content-type 是否内联,都强制走下载而非页面跳转
    a.download = '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setDownloaded(true);
    toast.success('已开始加速下载 🚀');
    setTimeout(() => refreshData(), 1500);
  };

  const fileNameForCmd =
    result?.fileName ||
    result?.sourceUrl?.split('/').filter(Boolean).pop() ||
    'download.bin';

  const snippets = useMemo(() => {
    if (!proxyFullUrl) return [];
    return [
      { id: 'wget', label: 'wget', code: `wget -O "${fileNameForCmd}" "${proxyFullUrl}"` },
      { id: 'curl', label: 'curl', code: `curl -L -o "${fileNameForCmd}" "${proxyFullUrl}"` },
      ...(result?.type === 'clone'
        ? [{ id: 'git', label: 'git clone', code: `git clone "${proxyFullUrl}"` }]
        : []),
    ];
  }, [proxyFullUrl, fileNameForCmd, result]);

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100 relative overflow-x-hidden">
      {/* 背景装饰 */}
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute top-[-20%] left-[10%] w-[500px] h-[500px] rounded-full bg-emerald-500/[0.07] blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[5%] w-[400px] h-[400px] rounded-full bg-teal-500/[0.05] blur-[100px]" />
        <div
          className="absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
          }}
        />
      </div>

      {/* 头部 */}
      <header className="border-b border-white/[0.06]">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-500 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Zap className="w-5 h-5 text-emerald-950" strokeWidth={2.5} />
            </div>
            <div>
              <h1 className="font-bold tracking-tight leading-none">GHFast</h1>
              <p className="text-xs text-zinc-500 mt-0.5">GitHub 加速下载</p>
            </div>
          </div>
          <Badge
            variant="outline"
            className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          >
            <span className="relative flex size-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex rounded-full size-2 bg-emerald-400" />
            </span>
            在线
          </Badge>
        </div>
      </header>

      <main className="flex-1 w-full max-w-4xl mx-auto px-4 pb-16">
        {/* Hero */}
        <section className="text-center pt-12 pb-8">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
            GitHub 文件
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-teal-300">
              {' '}极速加速下载
            </span>
          </h2>
          <p className="mt-3 text-sm sm:text-base text-zinc-400 max-w-xl mx-auto">
            粘贴 GitHub 链接或任意网址,本站充当临时代理服务器为你流式加速转发:
            Releases、仓库压缩包、Raw 文件、Gist 与 git clone 全支持。
            还能整页代理浏览任意网站 —— 页内链接与 JS 动态资源自动钩住改写,冲浪不跳出。
          </p>
        </section>

        {/* 输入卡片 */}
        <Card className="p-4 sm:p-6 border-white/[0.08] bg-zinc-900/60 backdrop-blur shadow-2xl shadow-black/40">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Github className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="粘贴 GitHub 链接或任意网址,如 https://github.com/user/repo/releases/download/..."
                className="pl-9 h-11 font-mono text-xs sm:text-sm bg-zinc-950/70 border-white/10 focus-visible:ring-emerald-500/50 placeholder:text-zinc-600 placeholder:font-sans"
                aria-label="加速链接输入框"
                autoFocus
              />
            </div>
            <Button
              onClick={() => analyze(input)}
              disabled={analyzing || !input.trim()}
              className="h-11 px-6 bg-emerald-500 hover:bg-emerald-400 text-emerald-950 font-semibold transition-colors min-w-28"
            >
              {analyzing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> 解析中
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4" /> 解析链接
                </>
              )}
            </Button>
          </div>

          {/* 示例快捷填充 */}
          <div className="flex flex-wrap items-center gap-2 mt-4">
            <span className="text-xs text-zinc-500">试试:</span>
            {EXAMPLES.map((ex) => {
              const Icon = ex.icon;
              return (
                <button
                  key={ex.label}
                  onClick={() => setInput(ex.url)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border border-white/10 bg-white/[0.03] text-zinc-400 hover:text-emerald-300 hover:border-emerald-500/40 hover:bg-emerald-500/10 transition-colors cursor-pointer"
                >
                  <Icon className="w-3 h-3" />
                  {ex.label}
                </button>
              );
            })}
          </div>
        </Card>

        {/* 解析结果 */}
        <section aria-live="polite" className="mt-6">
          {analyzing && !result && (
            <Card className="p-5 border-white/[0.08] bg-zinc-900/40 space-y-3">
              <Skeleton className="h-5 w-2/3 bg-white/[0.06]" />
              <Skeleton className="h-4 w-1/3 bg-white/[0.06]" />
              <Skeleton className="h-10 w-full bg-white/[0.06]" />
            </Card>
          )}

          {result && result.valid === false && input.trim() !== '' && !analyzing && (
            <Card className="p-5 border-red-500/25 bg-red-500/[0.04]">
              <p className="text-sm text-red-300">❌ {result.error ?? '无法识别的链接'}</p>
            </Card>
          )}

          {result?.valid && !analyzing && (
            <Card className="overflow-hidden border-white/[0.08] bg-zinc-900/60 backdrop-blur">
              <div className="p-4 sm:p-5">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="shrink-0 w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center">
                      {(() => {
                        const Icon = TYPE_ICONS[result.type ?? 'other'] ?? FileText;
                        return <Icon className="w-5 h-5 text-emerald-300" />;
                      })()}
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium truncate" title={result.fileName ?? ''}>
                        {result.fileName ?? `${result.owner}/${result.repo}`}
                      </p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {result.type && (
                          <Badge
                            variant="outline"
                            className={`text-[11px] px-1.5 py-0 ${
                              TYPE_BADGE_STYLES[result.type] ?? ''
                            }`}
                          >
                            {result.typeLabel}
                          </Badge>
                        )}
                        <span className="text-xs text-zinc-500">
                          {formatBytes(result.sizeBytes)}
                        </span>
                        {result.owner && result.repo && (
                          <a
                            href={result.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-zinc-500 hover:text-emerald-300 underline underline-offset-2 decoration-zinc-700 truncate max-w-45 inline-block"
                          >
                            {result.owner}/{result.repo}
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                  <Button
                    onClick={handleDownload}
                    className="bg-emerald-500 hover:bg-emerald-400 text-emerald-950 font-semibold px-6 h-10 shadow-lg shadow-emerald-500/20"
                  >
                    <Download className="w-4 h-4" />
                    {downloaded ? '再次下载' : '立即下载'}
                  </Button>
                </div>

                {/* 加速链接 + 操作 */}
                <div className="mt-4 rounded-lg border border-white/[0.08] bg-zinc-950/80 p-3">
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium flex items-center gap-1">
                      <ShieldCheck className="w-3 h-3 text-emerald-400" /> 加速直链(可直接分享)
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono text-emerald-300/90 truncate block select-all">
                      {proxyFullUrl}
                    </code>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-zinc-400 hover:text-emerald-300 hover:bg-white/5"
                        onClick={() => copyText(proxyFullUrl)}
                        aria-label="复制加速链接"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-zinc-400 hover:text-emerald-300 hover:bg-white/5"
                        onClick={() => window.open(proxyFullUrl, '_blank')}
                        aria-label="新窗口打开加速链接"
                      >
                        <Link2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>

                {/* 命令行片段 */}
                {snippets.length > 0 && (
                  <Tabs defaultValue={snippets[0]?.id} className="mt-4">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <TabsList className="bg-zinc-950/80 border border-white/[0.08] h-8 p-0.5">
                        {snippets.map((s) => (
                          <TabsTrigger
                            key={s.id}
                            value={s.id}
                            className="text-xs h-7 px-3 data-[state=active]:bg-emerald-500/15 data-[state=active]:text-emerald-300 gap-1"
                          >
                            <Terminal className="w-3 h-3" /> {s.label}
                          </TabsTrigger>
                        ))}
                      </TabsList>
                    </div>
                    {snippets.map((s) => (
                      <TabsContent key={s.id} value={s.id}>
                        <div className="relative rounded-lg border border-white/[0.08] bg-zinc-950/90 p-3 pr-24 overflow-hidden">
                          <pre className="text-xs font-mono text-zinc-300 whitespace-pre-wrap break-all leading-relaxed scrollbar-thin overflow-x-auto max-h-32 overflow-y-auto">
                            {s.code}
                          </pre>
                          <button
                            onClick={() => copyText(s.code)}
                            className="absolute right-2 top-2 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border border-white/10 bg-white/5 text-zinc-400 hover:text-emerald-300 hover:border-emerald-500/40 transition-colors cursor-pointer"
                          >
                            <Copy className="w-3 h-3" /> 复制
                          </button>
                        </div>
                      </TabsContent>
                    ))}
                  </Tabs>
                )}
              </div>
            </Card>
          )}
        </section>

        {/* 支持类型说明 */}
        <section className="mt-10">
          <h3 className="text-sm font-semibold text-zinc-400 mb-3 flex items-center gap-2">
            <span className="w-1 h-3.5 rounded bg-emerald-400 inline-block" />
            支持的链接类型
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {[
              { icon: Package, title: 'Releases 文件', desc: '发布版二进制与安装包', color: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' },
              { icon: Archive, title: '仓库压缩包', desc: '分支 / 标签源码 zip、tar.gz', color: 'text-amber-300 bg-amber-500/10 border-amber-500/20' },
              { icon: FileText, title: 'Raw 文件', desc: 'raw.githubusercontent 直链文件', color: 'text-sky-300 bg-sky-500/10 border-sky-500/20' },
              { icon: Braces, title: 'Gist 片段', desc: 'gist 上的代码片段文件', color: 'text-fuchsia-300 bg-fuchsia-500/10 border-fuchsia-500/20' },
              { icon: GitBranch, title: 'Git Clone', desc: '智能 HTTP 协议透传克隆', color: 'text-teal-300 bg-teal-500/10 border-teal-500/20' },
              { icon: Globe, title: '整页代理浏览', desc: '页面内链接与 JS 动态资源自动钩住改写', color: 'text-rose-300 bg-rose-500/10 border-rose-500/20' },
              { icon: Zap, title: '断点续传', desc: '透明转发 Range 分段请求', color: 'text-orange-300 bg-orange-500/10 border-orange-500/20' },
              { icon: ShieldCheck, title: '任意域名', desc: '不限 GitHub 系域名,全网站均可代理', color: 'text-lime-300 bg-lime-500/10 border-lime-500/20' },
            ].map((t) => (
              <Card
                key={t.title}
                className="p-4 border-white/[0.06] bg-white/[0.02] hover:border-emerald-500/25 hover:bg-emerald-500/[0.03] transition-colors"
              >
                <div className={`w-8 h-8 rounded-lg border flex items-center justify-center mb-3 ${t.color}`}>
                  <t.icon className="w-4 h-4" />
                </div>
                <p className="text-sm font-medium">{t.title}</p>
                <p className="text-xs text-zinc-500 mt-1">{t.desc}</p>
              </Card>
            ))}
          </div>
        </section>

        {/* 数据统计 */}
        <section className="mt-10 grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: '累计请求', value: stats ? String(stats.totalRequests) : '—' },
            { label: '累计传输量', value: stats ? formatBytes(stats.totalBytes) : '—' },
            { label: '今日请求', value: stats ? String(stats.todayRequests) : '—' },
            { label: '覆盖仓库', value: stats ? String(stats.reposServed) : '—' },
          ].map((s) => (
            <Card key={s.label} className="p-4 border-white/[0.06] bg-white/[0.02] text-center">
              <p className="text-xl sm:text-2xl font-bold text-emerald-300 font-mono tabular-nums">
                {s.value}
              </p>
              <p className="text-xs text-zinc-500 mt-1">{s.label}</p>
            </Card>
          ))}
        </section>

        {/* 历史记录 */}
        <section className="mt-10">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-zinc-400 flex items-center gap-2">
              <span className="w-1 h-3.5 rounded bg-emerald-400 inline-block" />
              最近加速记录
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={refreshData}
              className="h-7 text-xs text-zinc-500 hover:text-emerald-300 hover:bg-white/5"
            >
              刷新
            </Button>
          </div>
          <Card className="border-white/[0.06] bg-white/[0.02] overflow-hidden">
            {history.length === 0 ? (
              <div className="py-14 text-center text-sm text-zinc-600">
                <History className="w-8 h-8 mx-auto mb-3 opacity-40" />
                暂无下载记录,下载一条试试吧
              </div>
            ) : (
              <ul className="divide-y divide-white/[0.05] max-h-96 overflow-y-auto scrollbar-thin">
                {history.map((r) => {
                  const Icon = TYPE_ICONS[r.type] ?? FileText;
                  const isErr = r.status !== 'ok';
                  return (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors">
                      <div
                        className={`shrink-0 w-8 h-8 rounded-md border flex items-center justify-center ${
                          isErr
                            ? 'border-red-500/30 bg-red-500/10 text-red-300'
                            : 'border-white/10 bg-white/[0.03] text-emerald-300'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate">
                          {isErr
                            ? `下载失败:${r.owner ? `${r.owner}/${r.repo}` : r.sourceUrl}`
                            : r.fileName ?? r.sourceUrl}
                        </p>
                        <p className="text-[11px] text-zinc-600 font-mono truncate">{r.sourceUrl}</p>
                      </div>
                      <div className="shrink-0 text-right hidden sm:block">
                        <p className="text-xs text-zinc-500">{formatBytes(r.sizeBytes)}</p>
                        <p className="text-[11px] text-zinc-600">{timeAgo(r.createdAt)}</p>
                      </div>
                      {!isErr && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="shrink-0 h-7 w-7 p-0 text-zinc-500 hover:text-emerald-300 hover:bg-white/5"
                          onClick={() => copyText(`${window.location.origin}${r.proxyPath}`, '已复制加速链接')}
                          aria-label="复制该条记录的加速链接"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </section>
      </main>

      {/* 页脚(始终吸底) */}
      <footer className="mt-auto border-t border-white/[0.06] pb-[env(safe-area-inset-bottom)]">
        <div className="max-w-4xl mx-auto px-4 py-6 text-center text-xs text-zinc-600 space-y-1">
          <p>
            GHFast · 由 Next.js 流式反向代理驱动 · 支持任意域名整页代理浏览,请勿滥用
          </p>
          <p>流量为本站临时转发,商用与大额持续负载请自建镜像</p>
        </div>
      </footer>
    </div>
  );
}
