# 桌搭子管理后台

独立的 Node.js 管理后台，负责以下服务器端业务：

- 管理员登录和版本发布
- EXE 安装包上传、保存和 Range 下载
- 更新清单生成、Ed25519 签名和 SHA-256 校验信息
- 6 位一次性激活码生成、查看、复制、使用和撤销
- 设备激活与更新授权

服务不负责开发或打包桌宠。C# 编译、Inno Setup 打包和安装包测试全部在本地 Windows 电脑完成，服务器只接收最终生成的 EXE。

服务不依赖第三方 Node.js 包或外部数据库。激活与授权数据使用 Node.js 内置 SQLite，版本信息和安装包保存在独立数据目录。

## 日常发布流程

1. 在本地完成桌宠开发和测试。
2. 在项目根目录生成安装包：

   ```powershell
   .\scripts\build-native.ps1 -Version 2.1.2
   ```

3. 打开 `https://你的域名/admin`。
4. 填写版本号和更新说明，上传 `dist-native` 中生成的 EXE。
5. 安装包先保存为草稿，确认后点击“发布”。
6. 已激活的桌宠会通过更新接口检测新版本。

服务器上不需要安装 .NET SDK、Inno Setup、Electron，也不需要运行桌宠打包命令。

## 激活与授权

- 管理员可以在后台批量生成 6 位数字与字母组合的一次性激活码。
- 每个激活码只能成功激活一台设备一次。
- 新生成的完整激活码经过 AES-256-GCM 加密后保存在 `activation.db`，管理员可以在后台查看和复制。
- 客户端使用 Windows DPAPI 保存设备授权。
- 更新清单和非过渡版安装包要求有效设备授权。
- `DESKPET_BOOTSTRAP_VERSION` 指定旧客户端可以公开获取的过渡版本，默认是 `2.1.0`。

## 主要地址

- `GET /healthz`：健康检查
- `GET /api/update/latest`：更新清单
- `GET|HEAD /downloads/<file>`：安装包下载
- `POST /api/activate`：设备激活
- `GET /admin`：管理后台

## 安全设计

- 管理密码使用 `crypto.scrypt` 加盐哈希，不保存明文。
- 管理会话使用 `Secure`、`HttpOnly`、`SameSite=Strict` Cookie。
- 管理写操作要求同源请求和 CSRF 令牌。
- 登录失败按来源 IP 限速，会话默认 8 小时失效。
- 上传大小上限为 300 MB，文件先写入临时路径，完成后原子移动。
- 更新清单使用 Ed25519 私钥签名，客户端只内置公钥。
- 激活码、授权、签名私钥、管理员密码哈希和安装包都保存在独立数据目录，不能放进公开网站目录。
- 正式环境必须通过 HTTPS 访问，Node.js 只监听 `127.0.0.1`，由宝塔的 Nginx 外网映射提供域名访问。

## 本地验证后台

需要 Node.js 24 或更高版本：

```powershell
cd update-server
npm run check
npm test

$env:DESKPET_PUBLIC_URL='http://127.0.0.1:3100'
$env:DESKPET_HTTP_HOST='127.0.0.1'
$env:DESKPET_HTTP_PORT='3100'
$env:DESKPET_DATA_DIR="$PWD\work\data"
$env:DESKPET_ADMIN_LOOPBACK_ONLY='false'
npm run set-password
npm start
```

本地测试数据位于 `update-server\work\data`，不要上传到服务器覆盖生产数据。

## 生产部署

按照 [宝塔部署文档](BAOTA_DEPLOYMENT.md) 操作。宝塔负责 Node.js 版本、PM2 进程守护、Nginx 外网映射和 HTTPS；本项目不要求 Docker、MySQL、Caddy 或 systemd 服务文件。
