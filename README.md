# 桌搭子更新服务

这是一个可独立部署的 Express 5 应用，为桌搭子提供管理后台、版本发布、更新下载、一次性激活码、设备授权和用户反馈管理。

服务器只接收本地 Windows 电脑已经打包完成的 EXE，不负责编译 C#、运行 Inno Setup 或构建桌面应用。

## 运行要求

- Node.js 24 或更高版本，激活数据库使用 Node 内置 `node:sqlite`
- 可以直接使用 Node 的 HTTP 端口，也可以放在宝塔 Nginx 之后
- PM2 或宝塔 Node 项目管理器保持单实例运行
- 不要求 MySQL、Redis、Docker、.NET SDK 或 Inno Setup

## 快速开始

```powershell
cd update-server
npm ci
npm run check
npm test
```

本地运行前设置独立的数据目录：

```powershell
$env:DESKPET_PUBLIC_URL='http://127.0.0.1:3100'
$env:DESKPET_HTTP_HOST='127.0.0.1'
$env:DESKPET_HTTP_PORT='3100'
$env:DESKPET_DATA_DIR="$PWD\work\data"
npm run generate-signing-key
npm run set-password
npm start
```

然后访问：

```text
http://127.0.0.1:3100/healthz
http://127.0.0.1:3100/admin
```

## 问题反馈与建议

- 已授权的 Windows 客户端可提交“问题反馈”或“功能建议”，并查看当前设备的历史记录和后台回复。
- 每台设备最多同时保留 3 条活跃反馈；`pending`（待处理）和 `in_progress`（进行中）占用名额。
- 管理员在后台将反馈改为 `resolved`（已处理）或 `closed`（已关闭）后释放名额；重新改回活跃状态时会再次校验设备配额。
- 反馈数据独立保存在 `DESKPET_DATA_DIR/feedback.db`，重部署时必须与其他生产数据一起保留。

`generate-signing-key` 会输出客户端公钥。正式发布前，桌面客户端必须内置与服务器私钥配对的公钥。已有生产环境必须复用原来的整个数据目录，不能重新生成密钥。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动 Express 服务 |
| `npm run check` | 检查所有服务端 JavaScript 语法 |
| `npm test` | 运行 HTTP 端到端测试 |
| `npm run set-password` | 交互式设置管理员密码 |
| `npm run generate-signing-key` | 首次生成 Ed25519 签名密钥，拒绝覆盖旧密钥 |
| `npm run import-release -- <version> <exe>` | 从命令行导入并发布标准命名的 EXE，发布前执行完整校验 |

## 日常发布

1. 在主项目根目录执行 `./native/scripts/build-native.ps1 -Version <版本号>`。
2. 打开 `https://8.134.130.155/admin` 并登录。
3. 填写版本号和更新说明，上传 `native/dist` 中的 EXE。
4. 上传完成后版本是草稿；点击发布时，服务端会自动验证版本与文件名、文件大小、SHA-256 和 Ed25519 清单签名。
5. 已授权客户端下一次检查更新时取得带 Ed25519 签名的清单。

## 配置

| 环境变量 | 生产示例 | 说明 |
| --- | --- | --- |
| `DESKPET_PUBLIC_URL` | `https://8.134.130.155` | 对外地址，参与 Origin 和下载地址生成；本地运行时改为 `http://127.0.0.1:3100` |
| `DESKPET_DATA_DIR` | `/www/deskpet-data` | 生产数据目录，必须位于网站代码目录之外 |
| `DESKPET_HTTP_HOST` | `127.0.0.1` | Node 监听地址 |
| `DESKPET_HTTP_PORT` | `3100` | Node 内部端口 |
| `DESKPET_TRUST_PROXY` | `true` | 使用 Nginx 时，仅信任本机反向代理传入的来源 IP |
| `DESKPET_SIGNING_PRIVATE_KEY` | `/www/deskpet-data/signing-private.pem` | Ed25519 私钥路径 |
| `DESKPET_BOOTSTRAP_VERSION` | `2.1.0` | 未激活旧客户端可公开取得的过渡版本 |
| `DESKPET_BRAND_ICON` | 可选 | 管理后台图标绝对路径 |

完整模板位于 `deploy/baota.env.example`。

## 代码导航

- [服务端架构与业务逻辑](ARCHITECTURE.md)：模块职责、请求链路、发布/激活/下载流程和数据文件
- [宝塔部署文档](BAOTA_DEPLOYMENT.md)：包含全新服务器从克隆代码到首次验收的逐步流程
- `server.js`：宝塔保持不变的启动入口
- `src/`：Express 路由、控制器、中间件和业务服务
- `lib/`：版本文件和 SQLite 持久化
- `public/`：管理后台页面

## 安全约束

- 应用不强制校验 HTTPS；公网部署仍建议使用 Nginx + HTTPS，Node 端口不要直接暴露到公网。
- 当前桌面客户端默认连接 `https://8.134.130.155/api/update/latest`，更换服务地址或改用 HTTP 时必须同步修改客户端地址并重新打包。
- 管理密码只保存 scrypt 哈希，会话 Cookie 使用 `HttpOnly`、`SameSite=Strict` 和生产环境 `Secure`。
- 所有管理写操作同时验证会话、同源请求和 CSRF 令牌。
- EXE 以流方式上传并限制为 300 MB，不会整体读入内存。
- 正式版本的清单和下载都要求有效设备授权。
- `signing-private.pem`、`activation-*.key`、数据库和版本文件不得进入 Git。

生产部署请直接按 [BAOTA_DEPLOYMENT.md](BAOTA_DEPLOYMENT.md) 操作。
