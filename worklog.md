# Worklog

---
Task ID: 1
Agent: main (Z.ai Code)
Task: 开发 GitHub 加速下载服务器(GHFast)—— Next.js 全栈应用

Work Log:
- 设计 Prisma Schema 新增 DownloadRecord 模型(sourceUrl/proxyPath/type/owner/repo/fileName/sizeBytes/status),`bun run db:push` 推送成功
- 开发核心库 `src/lib/github-proxy.ts`:域名白名单校验(github.com / githubusercontent.com 等后缀)、URL 归一化(自动补协议、支持 owner/repo 简写)、链接类型识别(release/archive/raw/gist/codeload/clone)、响应头挑选与注入防护
- 开发流式反向代理 `/gh/[scheme]/[...rest]/route.ts`:支持 GET/POST/HEAD,流式转发 upstream body,透传 Range 实现断点续传,过滤逐跳头,转发 git 智能协议查询参数,下载记录落库,超时与上游错误友好化
- 关键决策:代理路径采用无双斜杠形式 `/gh/https/github.com/o/r/...`,规避 Next.js 将 `://` 折叠为 `:/` 触发 308 重定向(会破坏 curl/git 直连);同时兼容已被折叠的历史形式
- 开发 API:`/api/analyze`(解析+HEAD 探测文件大小)、`/api/history`、`/api/stats`(BigInt 手动转 Number 防 JSON 序列化异常)
- 开发前端 `src/app/page.tsx`:深色 emerald 主题、防抖自动解析、结果卡片(类型徽章/大小/加速直链复制/wget-curl-gitclone 命令片段 Tabs)、示例快捷填充、类型说明网格、统计卡片、历史记录列表(max-h-96 滚动+自定义滚动条)、min-h-screen flex + mt-auto 吸底页脚
- 修复:下载锚点补 `download` 属性,防止 text/plain 内联类型劫持页面导航
- 修复:历史失败记录显示 `?/?` 的问题,改为显示源链接
- layout.tsx 改为 zh-CN + dark class + sonner Toaster;globals.css 增加自定义滚动条样式

Stage Summary:
- 全链路验证通过:raw 文件代理下载 ✓、Release 71.6MB 流式下载实测 ~10MB/s ✓、Range 断点续传 ✓、真实 `git clone` 经代理克隆 octocat/Hello-World 成功 ✓、404/白名单外域名错误处理 ✓
- 浏览器端到端自验证通过(Agent Browser):渲染、自动解析、下载交互、toast、历史刷新、移动端 390px 无横向溢出、页脚自然推下、控制台无错误
- 用户在预览面板实际下载了 364MB 文件,统计与历史实时记录正常
- lint 通过,无错误
