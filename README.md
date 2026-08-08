# 桌搭子更新服务

这是一个可独立部署的 Express 5 应用，为桌搭子提供管理后台、版本发布、更新下载、一次性激活码、设备授权、账号互动统计、互动内容库和用户反馈管理。

服务器只接收本地 Windows 电脑已经打包完成的 EXE，不负责编译 C#、运行 Inno Setup 或构建桌面应用。

## 运行要求

- Node.js 24 或更高版本，激活数据库使用 Node 内置 `node:sqlite`
- 公网必须通过宝塔 Nginx 的域名 HTTPS 入口，Node HTTP 端口只供本机或受控内网使用
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

## 账号互动数据

- 已授权客户端可读取或更新安静、标准、热闹三档互动设置。
- 客户端按批上报心情选择、笑话查看、答题结果和内容展示事件，每个 `eventId` 幂等去重。
- 互动总数只统计完成的心情回答、笑话查看和答题；单纯展示内容不会增加互动总数。
- 服务端按 `accountId` 隔离数据，管理后台可查看互动次数、开心次数、笑话和答题汇总。
- 数据保存在 `DESKPET_DATA_DIR/interaction.db`；原始事件保留 90 天，去重回执和长期汇总继续保留。

## 互动内容库

- 管理后台可新增、编辑、启用或停用 `joke`、`math`、`trivia`、`riddle`、`tip`、`care` 六类内容，支持勾选批量禁用、按类型禁用，也可一次导入最多 500 条 JSON 数据。
- 客户端用设备授权按批获取内容。服务端会同时排除客户端指定 ID 和该账号近 30 天已展示内容，只有客户端上报 `content_shown` 后才进入近期排重。
- 批次默认返回 15 条、最多 30 条；完整离线包支持 `ETag`，客户端下载后可长期保存并在断网时使用。
- 每次内容变化都会递增 `catalogVersion`；响应包含停用 ID、SHA-256、Ed25519 签名和签名原文 `signedPayload`。客户端应使用更新清单同一公钥验证 Base64 解码后的原文字节，并以原文中解析出的内容为准。
- 内容数据保存在 `DESKPET_DATA_DIR/content.db`。可导入的格式见 `examples/content-import.example.json`。

`generate-signing-key` 会输出客户端公钥。正式发布前，桌面客户端必须内置与服务器私钥配对的公钥。已有生产环境必须复用原来的整个数据目录，不能重新生成密钥。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动 Express 服务 |
| `npm run migrate` | 手动执行未完成的 SQLite 迁移；服务启动时也会自动执行 |
| `npm run migrate:existing` | 迁移已有生产目录，并拒绝在错误路径创建空激活库 |
| `npm run check` | 检查所有服务端 JavaScript 语法 |
| `npm test` | 运行 HTTP 端到端测试 |
| `npm run set-password` | 交互式设置管理员密码 |
| `npm run generate-signing-key` | 首次生成 Ed25519 签名密钥，拒绝覆盖旧密钥 |
| `npm run import-release -- <version> <exe>` | 从命令行导入并发布标准命名的 EXE，发布前执行完整校验 |

## 账号与数据库迁移

激活码是账号入口，激活成功后由服务端创建稳定的 `accountId` 和设备级
`licenseId`。旧客户端继续使用原来的 Bearer 凭据；已有设备授权在升级后会自动
建立账号，不要求用户重新输入激活码。管理后台可以为已有账号生成 24 小时有效的
一次性换机码，新设备绑定成功后旧设备授权自动撤销，账号数据保持不变。

`activation.db`、`feedback.db`、`interaction.db` 和 `content.db` 使用 `schema_migrations` 记录迁移版本。
`npm start` 会在监听端口前自动执行迁移，也可在重启前手动执行：

```bash
DESKPET_DATA_DIR=/www/deskpet-data npm run migrate
```

生产迁移前必须停止单实例服务并备份整个 `DESKPET_DATA_DIR`。不要只复制单个
`.db` 文件，也不要替换现有 `activation-*.key` 或签名私钥。迁移只向前执行；需要
回退服务端版本时，应恢复升级前的完整数据目录备份。

## 日常发布

1. 在主项目根目录执行 `./native/scripts/build-native.ps1 -Version <版本号>`。
2. 打开 `https://in.desktoppet.online/admin` 并登录。
3. 填写版本号和更新说明，上传 `native/dist` 中的 EXE。
4. 上传完成后版本是草稿；点击发布时，服务端会自动验证版本与文件名、文件大小、SHA-256 和 Ed25519 清单签名。
5. 已授权客户端下一次检查更新时取得带 Ed25519 签名的清单。

## 配置

| 环境变量 | 生产示例 | 说明 |
| --- | --- | --- |
| `DESKPET_PUBLIC_URL` | `https://in.desktoppet.online` | 生产环境固定为规范域名并参与 Origin、后台及下载地址生成；仅本机回环地址可用于本地开发 |
| `DESKPET_DATA_DIR` | `/www/deskpet-data` | 生产数据目录，必须位于网站代码目录之外 |
| `DESKPET_HTTP_HOST` | `127.0.0.1` | Node 监听地址 |
| `DESKPET_HTTP_PORT` | `3100` | Node 内部端口 |
| `DESKPET_TRUST_PROXY` | `true` | 使用 Nginx 时，仅信任本机反向代理传入的来源 IP |
| `DESKPET_SIGNING_PRIVATE_KEY` | `/www/deskpet-data/signing-private.pem` | Ed25519 私钥路径 |
| `DESKPET_BOOTSTRAP_VERSION` | `2.5.6` | Windows x64 对外公开的稳定安装包版本回退值；发布版本后以 `publicVersions` 为准 |
| `DESKPET_MACOS_BOOTSTRAP_VERSION` | `2.2.4` | macOS 两种架构对外公开的稳定安装包版本回退值 |
| `DESKPET_BRAND_ICON` | 可选 | 管理后台图标绝对路径 |

完整模板位于 `deploy/baota.env.example`。

## 代码导航

- [服务端架构与业务逻辑](ARCHITECTURE.md)：模块职责、请求链路、发布/激活/下载流程和数据文件
- [宝塔部署文档](BAOTA_DEPLOYMENT.md)：包含全新服务器从克隆代码到首次验收的逐步流程
- `server.js`：宝塔保持不变的启动入口
- `src/`：Express 路由、控制器、中间件和业务服务
- `lib/`：版本文件和 SQLite 持久化
- `ACCOUNT_INTERACTION_PLAN.txt`：账号、迁移、随机互动、内容缓存和统计的实施方案
- `public/`：管理后台页面

## 安全约束

- 公网请求统一使用 `https://in.desktoppet.online`；错误 Host 和 HTTP 请求会跳转到该域名，Node 端口不要直接暴露到公网。
- Windows 与 macOS 客户端、管理后台、更新清单和下载地址全部使用域名。写死旧地址的客户端需要手动安装域名版客户端一次，不再保留公网 IP HTTPS 兼容入口。
- 管理密码只保存 scrypt 哈希，会话 Cookie 使用 `HttpOnly`、`SameSite=Strict` 和生产环境 `Secure`。
- 所有管理写操作同时验证会话、同源请求和 CSRF 令牌。
- EXE 以流方式上传并限制为 300 MB，不会整体读入内存。
- 网站公开稳定版本可直接下载；非公开草稿、历史包和授权更新清单仍要求有效设备授权。
- 增长数据只保存随机访客标识、安装标识哈希、平台/版本和日期，用于访问、下载、激活与 D1/D7/D30 留存汇总；“下载到激活”按首次启动设备作为安装漏斗分母。
- `signing-private.pem`、`activation-*.key`、数据库和版本文件不得进入 Git。

生产部署请直接按 [BAOTA_DEPLOYMENT.md](BAOTA_DEPLOYMENT.md) 操作。
