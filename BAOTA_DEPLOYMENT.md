# 宝塔部署说明

本文只部署 `update-server`。桌面应用的开发、编译、测试和 EXE 打包继续在本地 Windows 电脑完成。

## 0. 全新部署快速流程

以下步骤适用于服务器上没有旧代码、没有旧数据的情况。建议严格按顺序执行。

### 0.1 先确定对外地址

`DESKPET_PUBLIC_URL` 是管理后台、更新清单内下载链接和新客户端使用的公开地址，必须写完整协议和域名，不要以 `/` 结尾。

2.5.1 及之后的 Windows 客户端更新地址是：

```text
https://in.desktoppet.online/api/update/latest
```

因此，宝塔环境应使用：

```dotenv
DESKPET_PUBLIC_URL=https://in.desktoppet.online
```

生产环境的新客户端和管理后台统一使用上面的 HTTPS 地址。2.5.0 及之前的 Windows 客户端仍会先访问写死的 IP 更新地址，`DESKPET_PUBLIC_URL` 不会改变旧程序的请求入口；迁移期间必须另外保留可用的 IP HTTPS 反向代理，由旧客户端取得指向域名安装包的桥接更新清单。

### 0.2 准备域名和宝塔组件

1. 将域名解析到服务器公网 IP。
2. 在宝塔安装 Node.js 24.x、Nginx 和 Node 项目管理器。
3. 在宝塔网站中申请 HTTPS 证书，并将域名绑定到该站点。

### 0.3 克隆代码并安装运行依赖

以下命令在宝塔终端执行。仓库为私有仓库时，请改用 SSH 地址或宝塔 Git 凭据。

```bash
mkdir -p /www/wwwroot
cd /www/wwwroot
git clone https://github.com/W-CLL/deskpet.git deskpet
cd /www/wwwroot/deskpet
node --version
npm ci --omit=dev
npm run check
npm test
```

`node --version` 必须是 `v24.x`。`npm ci --omit=dev` 会按照 `package-lock.json` 安装 Express，不能只上传代码后直接启动。

### 0.4 创建数据目录并设置权限

```bash
mkdir -p /www/deskpet-data
chown -R www:www /www/wwwroot/deskpet /www/deskpet-data
chmod 700 /www/deskpet-data
```

代码目录和数据目录必须分开。数据目录不能放在 `/www/wwwroot/deskpet` 下，也不能加入 Git。

### 0.5 生成签名密钥并更新客户端公钥

全新环境且还没有发布客户端时执行：

```bash
cd /www/wwwroot/deskpet
export DESKPET_DATA_DIR=/www/deskpet-data
export DESKPET_SIGNING_PRIVATE_KEY=/www/deskpet-data/signing-private.pem
npm run generate-signing-key
```

命令输出一行 SPKI DER Base64 公钥。把它写入桌面项目 `native/ZhuoDazi/Services/UpdateService.cs` 的 `PublicKeySpki` 常量，然后再生成首个客户端。私钥只留在 `/www/deskpet-data/signing-private.pem`，不能提交到 Git 或发给客户端。

如果已经有客户端或旧服务器，不能执行这一步生成新密钥，必须从原服务器备份恢复 `signing-private.pem`，否则客户端会拒绝新版本签名。

### 0.6 设置管理员密码

`set-password` 必须在宝塔交互式终端中运行：

```bash
cd /www/wwwroot/deskpet
export DESKPET_DATA_DIR=/www/deskpet-data
npm run set-password
chown -R www:www /www/deskpet-data
chmod 700 /www/deskpet-data
```

按提示输入两次密码。密码至少 12 个字符，服务只保存 scrypt 哈希。

### 0.7 在宝塔添加 Node 项目

按第 6 节创建 Node 项目，并使用下面的环境变量。保存环境变量后再启动项目：

```dotenv
NODE_ENV=production
DESKPET_PUBLIC_URL=https://in.desktoppet.online
DESKPET_DATA_DIR=/www/deskpet-data
DESKPET_HTTP_HOST=127.0.0.1
DESKPET_HTTP_PORT=3100
DESKPET_TRUST_PROXY=true
DESKPET_SIGNING_PRIVATE_KEY=/www/deskpet-data/signing-private.pem
DESKPET_BOOTSTRAP_VERSION=2.1.0
```

### 0.8 配置 Nginx 外网映射

将域名反向代理到 `http://127.0.0.1:3100`，配置见第 7 节。上传 EXE 前必须设置 `client_max_body_size 300m`。

### 0.9 首次验收

```bash
curl -i http://127.0.0.1:3100/healthz
curl -i https://in.desktoppet.online/healthz
```

第二条命令的返回 JSON 应包含：

```json
{"ok":true,"service":"deskpet-update","configured":true,"activeVersion":null}
```

然后打开 `https://in.desktoppet.online/admin`，登录后依次测试生成激活码、上传草稿、发布版本和客户端下载。

## 1. 部署拓扑

```text
桌面客户端 / 管理员浏览器
           |
           | HTTPS 443
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
feedback.db*
interaction.db*
content.db*
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
DESKPET_PUBLIC_URL=https://in.desktoppet.online
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

反向代理只需要把 HTTPS 域名转发到 Node 的内部 HTTP 端口，至少传递这些头：

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
https://in.desktoppet.online/healthz
https://in.desktoppet.online/admin
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
.\native\scripts\build-native.ps1 -Version 2.1.2
```

得到：

```text
native\dist\ZhuoDazi-Desktop-Pet-2.1.2.exe
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

6. 确认数据目录后手动预执行数据库迁移：

   ```bash
   DESKPET_DATA_DIR=/www/deskpet-data npm run migrate:existing
   ```

   `migrate:existing` 会先确认 `activation.db` 确实存在，避免数据目录写错后生成一套空库。该步骤可提前发现目录权限、磁盘空间或数据库损坏问题。即使跳过，服务重新启动时
   也会在监听端口前自动执行未完成迁移。

7. 在宝塔重新启动项目。
8. 检查项目日志、`/healthz`、`/admin`、账号数量和一次客户端更新请求。

不要只执行 `git pull` 就结束：服务端依赖可能已经变化，`npm ci --omit=dev` 是更新流程的一部分。
不要在未设置 `DESKPET_DATA_DIR` 的普通 SSH Shell 中直接运行迁移，否则会在代码目录
创建一套新的空数据。迁移只向前执行；如需回退代码，应停止服务并恢复升级前备份。

## 11. 备份与恢复

定期对整个目录做一致性备份：

```text
/www/deskpet-data
```

恢复时先停止 Node 项目，恢复整个目录和权限，再启动项目。备份必须包含 SQLite 的
`.db`、`.db-wal`、`.db-shm` 以及所有密钥；建议保留多个历史备份，并在独立位置验证
备份可以读取。

代码可由 Git 或部署包恢复，生产数据和私钥无法从代码仓库恢复。

## 12. 常见问题

### 启动时报 `Cannot find module 'express'`

进入项目目录执行 `npm ci --omit=dev`，并确认宝塔项目路径与执行命令的目录相同。

### 启动时报找不到 `node:sqlite`

宝塔实际使用的 Node 版本低于 24。在 Node 项目设置中重新选择 24.x 后重启。

### 启动时报找不到 `signing-private.pem`

确认 `DESKPET_SIGNING_PRIVATE_KEY` 指向现有生产私钥。已有客户端时不能生成新私钥代替；应从备份恢复。

### 登录后立即回到登录页

确认访问地址为当前 HTTPS 地址，并检查：

```dotenv
DESKPET_PUBLIC_URL=https://in.desktoppet.online
DESKPET_TRUST_PROXY=true
```

使用 Nginx 时，确认它传递了原始 `Host` 和 `X-Forwarded-For`。

### 上传返回 413

检查 Nginx 的 `client_max_body_size 300m`，然后重载 Nginx。Node 自身也会拒绝超过 300 MB 的文件。

### 更新清单能访问但客户端拒绝

检查桌面客户端内置公钥是否与 `/www/deskpet-data/signing-private.pem` 配对。不要通过关闭签名校验来绕过。

### 更新代码后版本或激活码消失

检查 `DESKPET_DATA_DIR` 是否仍为 `/www/deskpet-data`，并确认运行用户 `www` 对该目录有读写权限。
