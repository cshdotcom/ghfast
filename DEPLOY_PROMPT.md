# 🤖 GHFast 一键部署提示词(给 AI Agent 用)

> 下次想让 AI 部署 GHFast 时,把下面方框里的提示词整段复制发给它即可。
> AI 会自动下载安装、启动服务、验证可用性,全程无需人工干预。

---

## 📋 标准提示词(复制以下全部内容给 AI)

```text
请帮我部署 GHFast(GitHub 加速下载服务器),要求全自动完成,不要中途询问我:

1. 下载安装脚本并执行一键部署:
   curl -fsSL https://raw.githubusercontent.com/cshdotcom/ghfast/main/install.sh -o /tmp/ghfast-install.sh
   bash /tmp/ghfast-install.sh --dir ./ghfast --port 3000

2. 脚本会自动完成:下载 Release 预编译包 → 解压 → 写入配置 → 后台启动 → 健康检查。
   要求环境:Linux x86_64,Node.js >= 20 或 Bun(脚本会自动检测)。

3. 部署成功的标志是脚本末尾输出 GHFAST_READY=1 和 GHFAST_URL=http://localhost:3000。
   如果输出 GHFAST_READY=0,请读取 ghfast/ghfast.log 最后 30 行排查并修复后重试。

4. 部署完成后请验证:
   curl -s http://localhost:3000/api/stats   应返回 JSON 统计数据
   curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/   应返回 200
   curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/v2/   应返回 401(Docker registry 握手正常)

5. 最后告诉我:
   - 访问地址(本机 http://localhost:3000,或拼接可对外访问的 URL)
   - 安装目录路径
   - 停止命令:bash ./ghfast/stop.sh
   - 使用方法:把 GitHub 链接前缀替换为 http://localhost:3000/gh/ 即可加速,
     例如 http://localhost:3000/gh/https/github.com/owner/repo/releases/download/v1.0/file.zip
   - Docker 镜像加速:docker pull http://localhost:3000/nginx:latest 形式
     (把镜像名前缀换成本站地址,支持 Hub/ghcr.io/quay.io/gcr.io/registry.k8s.io 等全部仓库),
     例:docker pull localhost:3000/ghcr.io/astral-sh/uv:latest
     或 daemon.json 配置 {"registry-mirrors": ["http://localhost:3000"]}(仅对 Docker Hub 生效)
```

---

## ⚙️ 可选参数(按需修改提示词中的命令)

| 参数 | 说明 | 示例 |
|---|---|---|
| `--dir <路径>` | 安装目录(默认 `./ghfast`) | `--dir /opt/ghfast` |
| `--port <端口>` | 服务端口(默认 `3000`) | `--port 8080` |
| `--version vX.Y.Z` | 指定版本(默认最新) | `--version v1.0.0` |
| `--no-start` | 只安装不启动 | |

## 🔧 常用运维命令

```bash
bash ./ghfast/stop.sh                    # 停止
nohup bash ./ghfast/start.sh > ./ghfast/ghfast.log 2>&1 &   # 启动
tail -f ./ghfast/ghfast.log              # 看日志
```

## 📦 相关链接

- 仓库:https://github.com/cshdotcom/ghfast
- Release:https://github.com/cshdotcom/ghfast/releases
- 在线脚本:https://raw.githubusercontent.com/cshdotcom/ghfast/main/install.sh
