# 服务端架构与业务逻辑

## 技术边界

本项目是独立的 Express 5 服务，只负责桌搭子的服务器端能力：

- 管理员登录、版本上传和发布
- 激活码、设备授权和撤销
- 更新清单签名及安装包下载
- 管理后台静态页面

桌面应用的编译、测试和 EXE 打包不在服务器执行。生产数据也不放在代码目录中，而是统一写入 `DESKPET_DATA_DIR`。

## 请求处理链

```text
Nginx（可选）
    -> Express access-policy（安全响应头和缓存策略）
    -> routes（HTTP 方法和路径）
    -> auth middleware（管理会话、CSRF）
    -> controllers（解析 HTTP 输入、设置状态码和响应头）
    -> services（业务规则、限速、签名、审计、上传流程）
    -> lib stores（JSON 文件、SQLite、安装包文件）
```

控制器不直接操作数据库，路由不包含业务判断。需要改变业务规则时优先修改 `src/services/`；需要改变数据格式时修改 `lib/`。

## 目录职责

```text
update-server/
├─ server.js                         # 稳定启动入口，供宝塔/PM2 使用
├─ src/
│  ├─ app.js                         # 创建 Express 应用并组装依赖
│  ├─ start-server.js                # HTTP Server、超时和优雅退出
│  ├─ config/app-config.js           # 环境变量、路径和容量限制
│  ├─ controllers/
│  │  ├─ admin-controller.js         # 管理 API 的 HTTP 输入输出
│  │  └─ public-controller.js        # 健康检查、激活、更新和下载
│  ├─ routes/
│  │  ├─ admin-routes.js             # /api/admin 路由及鉴权组合
│  │  └─ public-routes.js            # 对客户端开放的路由
│  ├─ services/
│  │  ├─ admin-auth-service.js       # 登录、会话、CSRF 和登录限速
│  │  ├─ activation-service.js       # 激活码、设备授权和激活限速
│  │  ├─ release-service.js          # 上传、发布、清单签名和下载规则
│  │  └─ audit-service.js            # 审计日志写入
│  ├─ middleware/
│  │  ├─ access-policy.js            # 安全响应头和缓存策略
│  │  ├─ json-body.js                # JSON 类型和大小限制
│  │  └─ error-handler.js            # 统一 JSON 错误格式
│  ├─ http/request-context.js        # 来源 IP、代理、Cookie、Range 工具
│  └─ errors/http-error.js           # 业务错误和存储错误映射
├─ lib/
│  ├─ storage.js                     # 版本元数据、安装包和审计文件
│  ├─ activation-store.js            # SQLite 激活码和设备授权
│  └─ security.js                    # 密码哈希、会话、令牌和限速器
├─ public/                            # 无构建步骤的管理后台页面
├─ scripts/                           # 密码、签名密钥和版本导入工具
├─ test/server.test.js                # HTTP 端到端回归测试
└─ deploy/baota.env.example           # 宝塔环境变量模板
```

## 版本发布流程

1. 管理员在后台提交版本号、EXE 文件名、大小和更新说明。
2. `ReleaseService.createUpload` 校验版本和文件，创建 15 分钟有效的上传任务。
3. 浏览器使用任务地址执行 `PUT`，服务端边接收边计算 SHA-256，并写入 `uploads/*.part`。
4. 完整接收后，`ReleaseStore.commitUpload` 将文件原子移动到 `releases/`，同时更新 `releases.json`。此时版本仍是草稿。
5. 管理员确认发布后，`ReleaseService.validateRelease` 再次核对版本号和标准文件名，检查磁盘文件大小，重新计算 SHA-256，并对更新清单签名后立即使用对应公钥验签。
6. 全部校验通过后，`ReleaseStore.publish` 才会更新 `activeVersion`；任一校验失败时版本保持草稿。
7. 每个关键动作和发布校验结果追加到 `audit.jsonl`。

网页后台发布和 `npm run import-release` 共用同一套发布前校验。安装包必须命名为 `ZhuoDazi-Desktop-Pet-<版本号>.exe`。

上传任务只保存在单进程内存中，因此 PM2 固定为一个实例。服务重启会使未完成的上传任务失效，但不会影响已经提交的版本。

## 激活与授权流程

1. 管理员生成 6 位一次性激活码。
2. 激活码用 HMAC 索引，并以 AES-256-GCM 密文保存到 SQLite；接口列表只返回掩码。
3. 客户端提交激活码、安装 ID 和随机凭据。
4. `ActivationStore.activate` 在 SQLite 事务内占用激活码并生成授权 ID，避免并发重复使用。
5. 同一安装 ID 和凭据可以安全重试；其他设备不能复用该激活码。
6. 客户端后续使用 `Bearer <licenseId>.<credential>` 请求受保护的更新和下载。
7. 管理员撤销授权后，后续鉴权立即失败。

IP 和安装 ID 分别限速，失败记录保存在进程内存中，重启后清空。

## 更新与下载流程

- 未带授权的客户端只能获得 `DESKPET_BOOTSTRAP_VERSION` 指定的公开过渡版本。
- 已授权客户端获得当前发布版本，并记录客户端版本和最近更新时间。
- 清单包含版本号、下载地址、SHA-256 和更新说明，并由 Ed25519 私钥签名。
- 非过渡版本的下载同样要求有效授权，避免只保护清单却暴露安装包。
- 下载支持 `GET`、`HEAD` 和单段 `Range`，可由客户端断点续传。

签名私钥必须与桌面客户端内置公钥配对。私钥丢失或随意更换后，已发布客户端将拒绝新的更新清单。

## 数据目录

生产环境建议固定为 `/www/deskpet-data`：

```text
auth.json                    管理员密码哈希
activation.db*               激活码和授权 SQLite 数据
activation-pepper.key        激活码 HMAC 密钥
activation-encryption.key    激活码加密密钥
signing-private.pem          更新清单 Ed25519 私钥
releases.json                版本元数据和当前版本
releases/                    已提交的 EXE
uploads/                     上传临时文件
audit.jsonl                  管理操作审计日志
```

这些文件是一个整体：备份、恢复或迁移时必须同时处理，不能只复制数据库或安装包。

## API 契约

| 方法 | 路径 | 权限 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/healthz` | 公开 | 进程和配置状态 |
| `POST` | `/api/activate` | 公开、限速 | 激活设备 |
| `GET` | `/api/update/latest` | 过渡版公开，正式版需授权 | 获取签名更新清单 |
| `GET/HEAD` | `/downloads/:fileName` | 过渡版公开，正式版需授权 | 下载安装包 |
| `POST` | `/api/admin/login` | 公开、限速 | 管理员登录 |
| `GET` | `/api/admin/session` | Cookie | 查询会话 |
| `GET/POST` | `/api/admin/releases` | 管理会话 | 列表或创建上传任务 |
| `PUT` | `/api/admin/uploads/:uploadId` | 管理会话 + CSRF | 流式上传 EXE |
| `POST` | `/api/admin/releases/:version/publish` | 管理会话 + CSRF | 发布版本 |
| `DELETE` | `/api/admin/releases/:version` | 管理会话 + CSRF | 删除非当前版本 |
| `GET/POST` | `/api/admin/activation-codes` | 管理会话 | 列表或生成激活码 |
| `POST` | `/api/admin/activation-codes/:id/reveal` | 管理会话 + CSRF | 查看完整激活码 |
| `POST` | `/api/admin/licenses/:id/revoke` | 管理会话 + CSRF | 撤销授权 |

API 错误统一返回：

```json
{
  "error": "可读错误信息",
  "code": "STABLE_ERROR_CODE"
}
```
