# 宝塔部署桌搭子管理后台

本文只部署 `update-server`。桌宠的开发、编译、打包和测试全部在本地 Windows 电脑完成。

## 1. 最终结构

```text
本地 Windows
  C# / WPF 源码
  .NET 10 SDK + Inno Setup 6
  dist-native/*.exe
          |
          | 浏览器上传
          v
宝塔服务器
  Node.js 24 + PM2
  桌搭子管理后台
  SQLite 激活数据、签名密钥、安装包
```

服务器不需要安装 .NET、Inno Setup、Electron、Docker 或 MySQL。

## 2. 宝塔准备

1. 在宝塔左侧进入“网站 > Node 项目 > Node 版本管理器”。
2. 安装 Node.js 24。
3. 安装 Nginx，用于域名反向代理和 HTTPS。
4. 确认域名已经解析到服务器公网 IP。
5. 云服务器安全组只需要对外开放 `80` 和 `443`；Node 的 `3100` 端口不要对公网开放。

宝塔的 Node 项目默认由 PM2 守护，项目崩溃或服务器重启后会自动拉起。宝塔官方操作界面可参考：[Node.js PM2 部署教程](https://docs.bt.cn/practical-tutorials/nodejs-pm2-deployment)。

## 3. 上传后台代码

在本地只打包 `update-server` 目录，必须包含：

```text
lib/
public/
scripts/
package.json
server.js
```

不要把以下内容放进部署压缩包：

```text
test/
work/
data/
dist-native/
native/
```

在宝塔“文件”中：

1. 创建 `/www/wwwroot/deskpet`。
2. 上传压缩包并解压，让 `server.js` 直接位于该目录下。
3. 确认 `/www/wwwroot/deskpet/public/app-icon.png` 存在。

## 4. 创建生产数据目录

在宝塔终端执行：

```bash
mkdir -p /www/deskpet-data
chown -R www:www /www/deskpet-data
chmod 700 /www/deskpet-data
```

这个目录保存生产数据，不能放在网站公开目录，也不能在以后更新后台代码时覆盖。主要内容包括：

```text
auth.json
activation.db
activation-encryption.key
signing-private.pem
releases.json
releases/
uploads/
audit.jsonl
```

## 5. 设置管理员密码

在宝塔终端执行：

```bash
cd /www/wwwroot/deskpet
export DESKPET_DATA_DIR=/www/deskpet-data
npm run set-password
chown -R www:www /www/deskpet-data
```

按提示输入两遍管理员密码。密码不会以明文保存。最后一条命令确保宝塔以 `www` 用户启动 Node 项目后可以读取数据。

## 6. 添加 Node 项目

进入“网站 > Node 项目 > 添加 Node 项目”，填写：

| 配置项 | 值 |
| --- | --- |
| 项目名称 | `deskpet` |
| 项目路径 | `/www/wwwroot/deskpet` |
| 启动文件 | `server.js` |
| 启动命令 | `npm start` |
| Node 版本 | `24.x` |
| 运行用户 | `www` |
| 内部端口 | `3100` |

如果当前宝塔版本只提供“启动文件”或“启动命令”其中一项，使用对应的一项即可，不要同时启动两个进程。

后台没有第三方 npm 依赖，宝塔界面中的“安装依赖”可以跳过；运行环境只需要 Node.js 24。

在项目的“环境变量”中加入：

```dotenv
DESKPET_PUBLIC_URL=https://desktoppet.online
DESKPET_DATA_DIR=/www/deskpet-data
DESKPET_HTTP_HOST=127.0.0.1
DESKPET_HTTP_PORT=3100
DESKPET_TRUST_PROXY=true
DESKPET_ADMIN_LOOPBACK_ONLY=false
DESKPET_SIGNING_PRIVATE_KEY=/www/deskpet-data/signing-private.pem
DESKPET_BOOTSTRAP_VERSION=2.1.0
```

保存并启动项目，在项目日志中确认没有报错。

## 7. 绑定域名与 HTTPS

1. 在 Node 项目设置中开启“外网映射”。
2. 绑定 `desktoppet.online`。
3. 上游地址使用 `http://127.0.0.1:3100`。
4. 在 SSL 设置中申请 Let's Encrypt 证书。
5. 证书生效后开启“强制 HTTPS”。

上传安装包最大允许 300 MB。若上传时出现 `413 Request Entity Too Large`，在该站点的 Nginx 配置 `server` 块中增加：

```nginx
client_max_body_size 300m;
proxy_request_buffering off;
proxy_read_timeout 600s;
```

保存配置并重载 Nginx。

## 8. 部署验证

依次访问：

```text
https://desktoppet.online/healthz
https://desktoppet.online/admin
```

`/healthz` 应返回类似：

```json
{"ok":true,"configured":true,"activeVersion":null,"tls":true}
```

首次登录后台后，测试以下功能：

1. 生成一个激活码。
2. 查看并复制激活码。
3. 上传一个本地生成的 EXE 为草稿。
4. 确认版本号和 SHA-256 后发布。

## 9. 以后发布桌宠

所有打包都在本地项目根目录执行：

```powershell
.\scripts\build-native.ps1 -Version 2.1.2
```

生成文件：

```text
dist-native\ZhuoDazi-Desktop-Pet-2.1.2.exe
```

然后登录 `https://desktoppet.online/admin`，上传为草稿并点击发布。正常发布不需要 SSH、SCP，也不需要在服务器执行打包命令。

## 10. GitHub 与宝塔 WebHook 自动更新

仓库地址：

```text
git@github.com:W-CLL/deskpet.git
```

这是私有仓库，建议使用只读 Deploy Key，不要把 GitHub 密码或访问令牌写进脚本：

1. 在宝塔“网站 > Git 创建”中复制服务器 SSH 公钥。
2. 打开 GitHub 仓库的 `Settings > Deploy keys`。
3. 添加公钥，不要勾选写入权限。
4. 在宝塔中克隆 `main` 分支到 `/www/wwwroot/deskpet`。
5. 确认宝塔 Node 项目名称也是 `deskpet`。

WebHook 部署脚本属于服务器私有配置，不放进 GitHub 仓库。将脚本单独保存在：

```text
/www/server/panel/script/deskpet-webhook.sh
```

先在宝塔终端测试：

```bash
chmod 700 /www/server/panel/script/deskpet-webhook.sh
bash /www/server/panel/script/deskpet-webhook.sh deskpet
```

脚本会执行：

1. 校验项目参数、固定仓库和 `main` 分支。
2. 拒绝覆盖服务器上的未提交代码改动。
3. 使用 `git fetch` 和 fast-forward 更新代码。
4. 执行 `npm run check` 和 `npm test`。
5. 重启名为 `deskpet` 的 PM2 项目。
6. 检查 `https://desktoppet.online/healthz`。

在宝塔 Git 管理或 WebHook 插件中，把执行脚本设置为：

```bash
bash /www/server/panel/script/deskpet-webhook.sh deskpet
```

复制宝塔生成的 WebHook URL，然后在 GitHub 仓库中进入 `Settings > Webhooks > Add webhook`：

- Payload URL：宝塔生成的 WebHook URL
- Content type：`application/json`
- Event：只选择 `push`
- SSL verification：宝塔面板有可信 HTTPS 证书时保持启用

宝塔当前 Git 创建与 WebHook 的官方流程见：[克隆 Git 仓库创建网站并实现自动更新](https://docs.bt.cn/practical-tutorials/create-from-git-website)。

WebHook 地址等同于部署凭据，不要放进 GitHub 仓库、截图或公开日志。

## 11. 手动更新后台代码

1. 先备份 `/www/deskpet-data`。
2. 在宝塔中停止 `deskpet` Node 项目。
3. 替换 `/www/wwwroot/deskpet` 中的后台代码。
4. 不要删除或覆盖 `/www/deskpet-data`。
5. 重新启动项目并检查项目日志和 `/healthz`。

## 12. 必须备份的内容

定期备份整个目录：

```text
/www/deskpet-data
```

其中的签名私钥、激活数据库和管理员密码记录缺一不可。私钥丢失后，新发布的更新将无法通过已安装客户端的签名验证。

## 13. 常见问题

### 后台登录后又跳回登录页

确认域名使用 HTTPS，并检查：

```dotenv
DESKPET_PUBLIC_URL=https://desktoppet.online
DESKPET_TRUST_PROXY=true
```

### 上传安装包返回 413

按第 7 节提高 Nginx 的 `client_max_body_size`。

### 项目提示找不到 `node:sqlite`

当前 Node.js 版本过低，在宝塔 Node 版本管理器中切换到 Node.js 24。

### 桌宠无法检查更新

先在浏览器访问 `/healthz`。如果浏览器正常而桌宠在 VPN 环境下失败，将 `desktoppet.online` 和服务器 IP 设置为 VPN 直连。

### 更新后台后数据不见了

检查 `DESKPET_DATA_DIR` 是否仍指向 `/www/deskpet-data`，不要把生产数据放进代码目录。
