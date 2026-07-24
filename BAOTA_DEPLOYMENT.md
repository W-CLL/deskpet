# 宝塔部署说明

本文只部署 `update-server`。桌面应用的开发、编译、测试和 EXE 打包继续在本地 Windows 电脑完成。

## 1. 部署拓扑

```text
桌面客户端 / 管理员浏览器
           |
           | HTTP 或 HTTPS
           v
宝塔 Nginx（可选：域名、证书、上传限制）
           |
           | HTTP 127.0.0.1:3100
           v
Express 5 + Node.js 24（单进程）
           |
           v
/www/deskpet-data（SQLite、密钥、版本和 EXE）
```

如果使用 Nginx，公网只开放 `80` 和 `443`，不要公开 `3100`。也可以直接将 Node 端口映射到内网或受控网络。

## 2. 宝塔准备

在宝塔面板中安装：

- Nginx
- Node 项目管理器
- Node.js 24.x

Node.js 24 是硬性要求，因为项目使用内置 `node:sqlite`。域名需要先解析到服务器公网 IP。

## 3. 上传代码

建议将代码根目录固定为：

```text
/www/wwwroot/deskpet
```

该目录内的 `server.js` 应直接存在。部署包至少包含：

```text
lib/
public/
scripts/
src/
deploy/baota.env.example
ecosystem.config.cjs
package.json
package-lock.json
server.js
```

不要上传 `node_modules/`、`test/`、`data/`、`work/`、EXE 或本地密钥。Linux 上用锁文件重新安装依赖：

```bash
cd /www/wwwroot/deskpet
npm ci --omit=dev
npm run check
```

Express 是运行依赖，因此不能再跳过依赖安装。以后 `package-lock.json` 变化时也必须重新执行 `npm ci --omit=dev`。

## 4. 创建生产数据目录

```bash
mkdir -p /www/deskpet-data
chown -R www:www /www/deskpet-data
chmod 700 /www/deskpet-data
```

生产数据必须与网站代码分开。以后替换代码时，只操作 `/www/wwwroot/deskpet`，不能覆盖 `/www/deskpet-data`。

数据目录最终包含：

```text
auth.json
activation.db*
activation-pepper.key
activation-encryption.key
signing-private.pem
releases.json
releases/
uploads/
audit.jsonl
```

### 已有生产环境

迁移或重装时，应恢复原来的整个 `/www/deskpet-data`，尤其不能重新生成 `signing-private.pem`、`activation-pepper.key` 或 `activation-encryption.key`。签名私钥变更后，已发布客户端会拒绝新清单；激活密钥变更后，旧激活码无法正常校验或查看。

### 全新环境

只有从未发布过客户端时才生成新的签名密钥：

```bash
cd /www/wwwroot/deskpet
export DESKPET_DATA_DIR=/www/deskpet-data
export DESKPET_SIGNING_PRIVATE_KEY=/www/deskpet-data/signing-private.pem
npm run generate-signing-key
```

命令会显示 SPKI DER Base64 公钥。必须把该公钥配置到桌面客户端的更新校验代码中，再打包首个客户端。脚本在私钥已经存在时会拒绝覆盖。

## 5. 设置管理员密码

在宝塔交互式终端中执行：

```bash
cd /www/wwwroot/deskpet
export DESKPET_DATA_DIR=/www/deskpet-data
npm run set-password
chown -R www:www /www/deskpet-data
chmod 700 /www/deskpet-data
```

密码至少 12 个字符，只保存 scrypt 哈希，不保存明文。

## 6. 创建 Node 项目

在“网站 > Node 项目 > 添加 Node 项目”中填写：

| 配置项 | 值 |
| --- | --- |
| 项目名称 | `deskpet` |
| 项目路径 | `/www/wwwroot/deskpet` |
| 启动文件 | `server.js` |
| 启动命令 | `npm start` |
| Node 版本 | `24.x` |
| 运行用户 | `www` |
| 内部端口 | `3100` |
| 实例数 | `1` |

部分宝塔版本只要求“启动文件”和“启动命令”中的一个，按界面要求填写即可，不要同时启动两个进程。

在项目环境变量中加入：

```dotenv
NODE_ENV=production
DESKPET_PUBLIC_URL=http://你的域名
DESKPET_DATA_DIR=/www/deskpet-data
DESKPET_HTTP_HOST=127.0.0.1
DESKPET_HTTP_PORT=3100
DESKPET_TRUST_PROXY=true
DESKPET_SIGNING_PRIVATE_KEY=/www/deskpet-data/signing-private.pem
DESKPET_BOOTSTRAP_VERSION=2.1.0
```

不要在值两侧加引号。保存后启动项目，并在日志中确认：

```text
deskpet-update http listening on 127.0.0.1:3100
```

仓库中的 `ecosystem.config.cjs` 可用于命令行 PM2 部署。使用宝塔 Node 项目管理器时，不需要再手工运行 `pm2 start`。

## 7. 配置域名和反向代理（可选）

应用本身不强制 HTTPS、Host 或端口。最简单的方式是直接访问 Node 端口；使用域名时，在 Node 项目中开启“外网映射”，上游为：

```text
http://127.0.0.1:3100
```

如果使用 HTTPS，可在宝塔申请 Let's Encrypt 证书；如果只在内网使用，普通 HTTP 即可。反向代理至少传递这些头：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

安装包最大允许 300 MB。在站点 Nginx 的 `server` 块中加入：

```nginx
client_max_body_size 300m;
proxy_request_buffering off;
proxy_read_timeout 600s;
proxy_send_timeout 600s;
```

保存并重载 Nginx。`DESKPET_TRUST_PROXY=true` 只信任来自本机的来源 IP 代理头，Node 仍建议监听 `127.0.0.1`。

## 8. 部署验证

先访问：

```text
http://或https://你的域名/healthz
http://或https://你的域名/admin
```

健康检查应类似：

```json
{
  "ok": true,
  "service": "deskpet-update",
  "configured": true,
  "activeVersion": null
}
```

然后在后台按顺序验证：

1. 登录并刷新页面，确认会话仍有效。
2. 生成一个激活码，查看并复制完整内容。
3. 上传一个本地生成的 EXE，确认显示为草稿。
4. 发布版本，检查当前版本和 SHA-256。
5. 使用测试客户端完成激活、检查更新和下载。

服务器终端再执行一次完整回归：

```bash
cd /www/wwwroot/deskpet
npm test
```

测试使用系统临时目录，不会修改 `/www/deskpet-data`。

## 9. 日常发布桌面版本

本地 Windows 项目根目录执行：

```powershell
.\scripts\build-native.ps1 -Version 2.1.2
```

得到：

```text
dist-native\ZhuoDazi-Desktop-Pet-2.1.2.exe
```

登录 `/admin` 上传为草稿并发布。正常发布桌面版本不需要 SSH，也不需要改服务器代码。

## 10. 更新服务端代码

1. 备份 `/www/deskpet-data`。
2. 在宝塔停止 `deskpet` Node 项目。
3. 更新 `/www/wwwroot/deskpet` 中的代码。
4. 不要删除、移动或覆盖 `/www/deskpet-data`。
5. 安装锁定依赖并验证：

   ```bash
   cd /www/wwwroot/deskpet
   npm ci --omit=dev
   npm run check
   npm test
   ```

6. 在宝塔重新启动项目。
7. 检查项目日志、`/healthz`、`/admin` 和一次客户端更新请求。

不要只执行 `git pull` 就结束：服务端依赖可能已经变化，`npm ci --omit=dev` 是更新流程的一部分。

## 11. 备份与恢复

定期对整个目录做一致性备份：

```text
/www/deskpet-data
```

恢复时先停止 Node 项目，恢复整个目录和权限，再启动项目。建议保留多个历史备份，并在独立位置验证备份可以读取。

代码可由 Git 或部署包恢复，生产数据和私钥无法从代码仓库恢复。

## 12. 常见问题

### 启动时报 `Cannot find module 'express'`

进入项目目录执行 `npm ci --omit=dev`，并确认宝塔项目路径与执行命令的目录相同。

### 启动时报找不到 `node:sqlite`

宝塔实际使用的 Node 版本低于 24。在 Node 项目设置中重新选择 24.x 后重启。

### 启动时报找不到 `signing-private.pem`

确认 `DESKPET_SIGNING_PRIVATE_KEY` 指向现有生产私钥。已有客户端时不能生成新私钥代替；应从备份恢复。

### 登录后立即回到登录页

确认访问地址与 `DESKPET_PUBLIC_URL` 使用相同的协议和域名，并检查：

```dotenv
DESKPET_PUBLIC_URL=http://或https://你的域名
DESKPET_TRUST_PROXY=true
```

使用 Nginx 时，确认它传递了原始 `Host` 和 `X-Forwarded-For`。

### 上传返回 413

检查 Nginx 的 `client_max_body_size 300m`，然后重载 Nginx。Node 自身也会拒绝超过 300 MB 的文件。

### 更新清单能访问但客户端拒绝

检查桌面客户端内置公钥是否与 `/www/deskpet-data/signing-private.pem` 配对。不要通过关闭签名校验来绕过。

### 更新代码后版本或激活码消失

检查 `DESKPET_DATA_DIR` 是否仍为 `/www/deskpet-data`，并确认运行用户 `www` 对该目录有读写权限。
