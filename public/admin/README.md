# 管理后台前端

支持深浅主题的管理后台，无打包器，由 Express 直出。

## 目录

```text
admin/
  index.html          # 壳层：登录、侧栏、顶栏、各业务页 DOM
  css/
    tokens.css        # 设计变量
    base.css          # 按钮、表单、表格、对话框、抽屉
    layout.css        # 登录、侧栏、顶栏、响应式
    pages.css         # KPI、设置、内容库等页面布局
  js/
    main.js           # 启动、登录态、路由、刷新
    core/
      ui.js           # 通用 UI 与 registerAdminPage
      form-kit.js     # 右侧抽屉编辑器
      ...
    pages/            # 按业务拆分的页面模块
```

## 约定

- 侧栏按「总览 / 发布授权 / 运营数据 / 内容运营 / 支持设置」分组
- 列表页优先：统计条 → 工具栏 → 表格 → 分页 → 抽屉/对话框编辑
- 新增静态文件放在 `public/admin/**`，通过 `/assets/admin/**` 访问，无需改白名单

## 页面维护与启动回归

`public/admin/index.html` 是正式后台唯一的页面源文件，包含完整的登录、导航、设置、列表及抽屉表单。新增功能应直接维护这个文件，并同步对应页面模块。`public/admin.html` 只是历史文件，不能拿它重新生成或覆盖正式页面。

`node scripts/assemble-admin.js` 现在只校验正式页面的关键 DOM、路由、页面脚本及重复 ID，不会写入文件；重复运行不会改变 HTML。正式页面缺失或不完整时命令直接失败，需要从版本控制恢复正确文件。脚本不再把历史文件当作回退来源。

3.5.3 发布时曾用过期生成脚本覆盖页面，丢失 `activationQrFile` 等设置控件，使真实页面工厂在绑定登录提交事件之前报错，表现为点击登录无反应。修复以完整正式页面为基础加入桌宠小铺、订单与卸载反馈入口，同时保留既有 270 个 DOM ID、导航子页和抽屉表单。

运行 `node --test test/admin-startup.test.js test/admin-theme.test.js` 可检查这一边界：测试用 jsdom 解析正式 HTML，按页面实际脚本顺序执行全部 14 个真实页面工厂及 `main.js`，确认会话初始化、导航、登录提交请求和错误提示正常；反例会移除二维码控件，确保测试能识别本次故障。测试仅模拟浏览器网络响应，不请求线上服务，也不使用真实账号密码。jsdom 仅为开发测试依赖，生产运行依赖不变。主题测试还检查校验脚本的幂等性、正式页面缺失时拒绝回退，以及主题头部修复后保留业务控件。

## 关键接口

- `GET /api/admin/overview`：首页运营/内容/运维 KPI

## 卸载反馈与安装批次

侧栏“卸载反馈”（`#uninstalls`）按设备查看当前安装状态、最近反馈、可信卸载时间和重装恢复时间，支持按状态筛选、按昵称/完整设备码/账号/平台/版本/原因搜索，以及 25/50/100 条分页。详情抽屉保留完整设备码、账号、授权记录、当前安装批次和最多 200 条事件历史；迟到事件会显示 `ignoredReason`，不会覆盖较新的安装状态。页面不会把离线、普通退出、关机、休眠或心跳中断推断为卸载，也不会在这里撤销授权、释放设备名额或删除购买权益。

客户端统一调用 `POST /api/device/install-events`。`installed_start` 与 `uninstall_intent` 使用现有设备的 `installationId` 和 `credential`，并提交 `schemaVersion: 1`、UUID `eventId`、稳定的 `installBatchId` / `installBatchCreatedAt`、`platform`、`appVersion` 和 `occurredAt`。卸载原因可空；非空时仅接受 `not_often_used`、`resource_usage`、`experience_issue`、`temporary_pause`、`other`，补充说明最多 500 字且只允许搭配 `other`。意向事件只记录反馈，不会把设备标为已卸载；成功响应会返回约两小时有效的一次性 `completionToken`。

只有受控卸载器完成删除后，才能用新 UUID `eventId`、原 `intentEventId`、一次性 `completionToken` 和完成阶段的 `occurredAt` 提交 `uninstall_completed`。同一个完成事件 ID 可安全重试；同一 token 改用另一事件 ID 会被拒绝。完成临时文件不得包含永久设备凭据。短超时、断网或服务失败均不阻止卸载；服务端没有收到可信完成事件时保持原状态，不根据活跃时间猜测。

设备状态为 `installed`、`uninstall_reported` 或 `restored`。普通覆盖升级保留安装批次，不算卸载；卸载器只在 `usPostUninstall` 删除本地批次标记。重装后首次联网启动创建并成功提交更新的批次，才会从 `uninstall_reported` 进入 `restored`；同批次延迟启动/心跳不能恢复，旧批次迟到的完成事件也不能覆盖新批次。

管理员列表接口为 `GET /api/admin/uninstalls?status=&q=&page=1&pageSize=25`，返回 `{ devices, total, page, pageSize, summary, serverTime }`；详情接口为 `GET /api/admin/uninstalls/:installationId`，返回 `{ device, events }`。两者均要求管理员会话并返回 `no-store`，响应不包含设备 credential 或卸载 completion token。

## 私人搭子在线状态

客户端搭子资料的 `partner` 增加 `online: boolean`，仅向已绑定的搭子提供在线判断，不返回另一方账号、设备或最后活跃时间。判定来自独立的 `private_last_seen_at`，最近 90 秒内有主动资料/来访轮询等请求视为在线；关闭大厅不影响私人状态，也不会使用户重新出现在大厅。后台查询、被动建立资料以及查看对方资料不会替对方续期。原顶层 `online` 仍表示大厅公开状态，旧客户端及大厅协议保持兼容。

桌面客户端发送前刷新资料，离线时确认是否继续投递。服务端保留既有私人离线队列：确认发送后等待对方上线接收，未接收来访 24 小时过期，最多积压 3 条；私人发送间隔仍为 1 秒。大厅继续按原在线接收规则处理。

## 桌宠小铺运营

侧栏“小铺订单”（`#pet-market-orders`）及桌宠管理页“订单列表”可查看所有账号付款订单，按待付款、已付款、已取消、已过期筛选，按桌搭子昵称、设备号、完整设备码、订单号、五位备注码、商品名称/标识或账号搜索，支持 25/50/100 条分页。上方总订单、待付款、已付款和已付总额为全局统计，不随筛选变化；金额按订单冻结值统计，免费领取不产生付款订单。列表的“购买者 / 设备”展示昵称、设备号和账号尾号；点击“查看详情”打开抽屉，显示完整订单号、账号、设备码、平台、锁定版本及创建、到期、付款、取消时间，支持复制订单号、账号和已记录的下单设备码。

管理员查询接口为 `GET /api/admin/pet-market/orders?status=&q=&page=1&pageSize=25`，需要管理员会话；返回 `{ orders, total, page, pageSize, summary, serverTime }`。`summary` 含 `total/pending/paid/canceled/expired/paidAmountFen`。查询本身不改变已付款状态、订单金额或用户权益，不提供客户端是否已启用的推测状态。

漏填付款备注或未被自动匹配的订单，可在列表或详情点击“手动确认收款”。待付款、已过期、已取消的订单均可进入确认抽屉：先核对订单号、昵称/设备、账号、桌宠、锁定版本和原订单金额，填写必填的核对说明，再勾选已核对付款人及金额，点击“确认收款并发放”。过期和取消状态会额外提示正在补确认历史订单。已付款订单不再显示该操作。

确认接口为 `POST /api/admin/pet-market/orders/:id/confirm-payment`，需要管理员写会话及 CSRF，正文为 `{ note, expectedAmountFen, received: true }`。`note` 必填且最多 600 字，金额必须与原订单锁定金额一致；账号、桌宠和资源版本由服务端原订单取得。成功返回 `{ order, duplicate, serverTime }`，订单改为已付款并发放购买权益，客户端下一次同步后沿用自动下载安装、用户手动启用流程。已付款订单的重复请求不重复发放或覆盖首次确认记录；同账号已经持有该桌宠的其他订单不能借此重复发放。冻结版本的资源不可用时返回明确错误，不先标记成功。

管理订单包含 `confirmationMethod` 和 `manualConfirmation`；人工确认记录保存说明、确认时间、管理员及确认前状态，详情显示“手动确认收款”。人工确认独立留痕，不伪造微信自动识别事件；这些运营备注不返回给客户端或公开接口。后台付款成功仍不表示客户端已安装或启用。

新订单从服务端已验证的授权身份保存下单设备、平台及当时的桌搭子昵称，重用待付款订单不会覆盖这些资料；之后改昵称或更换设备也不会改写下单记录。设备号与后台设备列表统一为完整设备码的末 12 位，详情保留完整设备码。缺少历史快照的订单不会倒填下单设备，而是显示“下单设备：未记录”；当前昵称和账号关联设备带有明确的“当前昵称 / 参考”标识。没有昵称或关联设备时显示未记录，不从账号 ID 或商品名称猜测。

管理员订单项增加 `buyerDisplayName`、`buyerNameSource`（`order_snapshot` / `current_profile` / `unknown`）、`buyerInstallationId`、`buyerDeviceCode`、`buyerPlatform`、`buyerDeviceSource`（`order_snapshot` / `unknown`）及 `accountDevices`。旧单的下单设备字段为 `null`，`accountDevices` 提供 `{ installationId, deviceCode, platform }` 供查找账号；新单的该数组为空。昵称与设备搜索在分页之前过滤。上述管理资料不加入公开或客户端订单响应，不接受客户端在下单正文中指定，也不返回设备凭据、激活码或内部授权密钥。

侧栏进入“桌宠小铺”，先新建桌宠并设置名称、价格、最多四个标签和精选标记；保存后直接选择角色文件夹或多选 GIF。服务端生成 `pet-market.json`、文件 SHA-256 与 ZIP，再走既有资源版本校验。勾选“资源校验通过后立即上架”可在验证成功后发布；已有版本也可在列表单独上架。原来上传包含清单的 ZIP 方式继续可用。

列表支持名称/标识/标签搜索、状态与价格筛选，显示价格、素材数量、默认和精选标记。缩略图只使用已发布商品当前允许公开的首张 `previewFiles`，不会为未上架或未开放预览的资源创建额外下载入口。

直接 GIF 上传仍使用 `POST /api/admin/pet-market/products/:id/versions`，请求包含 `version`、`sourceType: "gif-files"`、`fileSize`（所有 GIF 的字节总和）及 `files: [{ path, sizeBytes }]`；`fileName` 可省略，由服务端生成。随后向返回的 `uploadUrl` 发送二进制 PUT，按 `files` 顺序拼接每个 GIF 的原始字节。`path` 仅是包内安全相对路径，服务端不会将它当作本地磁盘路径读取。最多 80 个 GIF、单个 8 MB、总包 64 MB，拒绝空包、非 GIF、危险路径、大小写重复路径及尺寸不符的内容。

商品接口新增 `tags: string[]` 与 `isFeatured: boolean`；旧调用不传时分别默认为空数组和 `false`。已有数据库自动补列，原商品、版本、订单及权益保持不变。公开目录也返回这些展示字段，激活、权益和签名验证规则不变。

“收款设置”使用 `GET /api/admin/pet-market/payment-settings` 读取，使用带管理会话和 CSRF 的 `PUT` 保存；响应均为 `{ payment }`。配置字段为 `enabled`、`method`（`personal_transfer` / `collection_qr`）、`recipientName`、`recipientAccount`、`qrCodeDataUrl` 和 `instructions`。默认关闭且没有预填账号。开启好友转账必须填写昵称与微信号；开启收款码必须填写昵称并提供有效 PNG / JPEG data URL，图片不超过 256 KB，宽高不超过 2048。非法字段或图片会整体拒绝，保留原设置。

收款桥接器以现有 Bearer 令牌向 `POST /api/pet-market/payment-heartbeat` 报告 `{ accountId, noticeReady, transferReady, noticePollSuccess, transferPollSuccess, pollLimitSaturated }`。心跳使用服务端收到时间，60 秒内有效，不接受调用方时间；服务重启后必须重新收到心跳。该窗口覆盖结构化数据源遍历和有界 Busy 重试的实际耗时，订单有效期仍为 15 分钟。短暂 Busy 延后上报且不续期，成功读取后才恢复在线心跳；硬错误、读取饱和或受控停止立即上报不可用状态，无需等待 60 秒。好友转账依赖 transfer 来源、收款码依赖 notice 来源；对应来源必须 ready 且最近读取成功，读取不能饱和，账号必须与服务端实际收款账号一致。默认占位账号不能使监听上线。

公开目录 `payment` 和订单 `order.payment` 返回收款展示字段、`available`、`listenerOnline` 与 `unavailableReason`，不返回内部账号或桥接令牌。只有设置开启、填写完整且实际监听健康时才接受新订单；暂不可用时返回 `503 PAYMENT_UNAVAILABLE`。现有未过期订单仍被复用并附不可用原因。每个新订单冻结当时的收款方式、目标和说明，后续改设置不会替换旧订单目标；旧订单按原方式检查监听，管理端关闭收款可暂停所有订单的付款入口。已结束订单不会继续提示付款。

迁移前尚无收款快照的 pending 订单，只在收款服务可用时建立一次快照。内部目标为当前真实账号时可以冻结；仅精确的 `local-demo-collection` 开发占位目标允许首次绑定真实账号并记录 `bind_payment_target` 审计，其余旧真实账号不允许改绑。绑定不修改原订单 ID、短码、金额、商品版本、状态或有效期。已有快照不再重写；既有好友转账自动授权策略不变。

已激活客户端使用原 Bearer 凭据调用 `GET /api/pet-market/orders` 获取 `{ orders, serverTime, nextCursor }`。按创建时间和 ID 倒序返回当前账号订单，保留已付款、取消和过期记录；每页最多 100 条且订单 JSON 总量不超过 700 KB。`nextCursor` 非空时通过 `?cursor=<nextCursor>` 读取下一页，客户端应继续读取至 `null`，不能静默只展示第一页。每项沿用订单详情字段并增加 `productTitle` 和 `payment`，包含 `paidAt` / `canceledAt` / `createdAt` / `expiresAt`。pending 保留完整收款二维码；终态只返回冻结的收款摘要，`qrCodeDataUrl` 为空字符串。迁移前未留快照的终态订单返回 `payment: null`，不会用当前设置冒充旧目标。接口不接受调用方账号作为查询身份，未激活、失效或撤销凭据不能读取；响应为 `private, no-store`。

## 免费小剧场与互动词库

桌宠小铺提供“管理小剧场 / 互动词库”入口跳转到资源包页面。页面说明免费下载且安装后默认待启用；用户在对应设置中决定何时开启，后台上架不会自动开启用户内容。

继续使用现有资源包接口，无激活或付款要求。公开 `GET /api/public/resource-packs` 返回 `{ generatedAt, packs }`；可用 `?kind=theater` / `?kind=wordpack`，或原分类 `?category=theater-scripts` / `?category=interaction-words` 筛选。仅上架且校验通过的资源可见。条目保留 `id`、`category`、`title`、`description`、`originalName`、`size`、`sha256`、`createdAt` 和 `url`，增加 `kind`、`status`、`version`、`fileCount`、`sizeBytes`、`updatedAt`、`downloadPath`，并固定 `free: true`、`chargingMode: "free"`、`priceFen: 0`。匿名 `GET /resource-packs/:id/download` 下载原 ZIP；下架后目录和下载入口立即不可用。

管理端仍在“资源包”上传：`POST /api/admin/resource-packs` 登记 `{ category, title, description, fileName, fileSize, status?, version? }`，再向返回 `uploadUrl` 二进制 PUT。默认状态 `published`、版本 `1.0.0`；也可上传为 `draft`。`PATCH /api/admin/resource-packs/:id` 支持改 `title`、`description`、`category`、`status`（`draft` / `published` / `unlisted`），需管理会话与 CSRF。改分类或上架会重新检查文件内容；改变展示名称不会改 ZIP 字节或 SHA-256。后台提供编辑和上下架操作，历史无效包仍可在管理端看到校验原因，公开目录会过滤它们。

ZIP 中放 1–80 个独立 UTF-8 JSON，可位于子目录；不需要新清单。单文件最多 256 KB，总解压大小最多 20 MB，ZIP 最多 50 MB。只允许 JSON 和可选 `README.txt` / `README.md`，拒绝空包、越界路径、链接、重复文件、加密或损坏 ZIP；README 不用于安装。旧包在服务初始化时重新校验内容和 SHA-256，旧的空 ZIP 不会被当作可安装资源。

下载会通过同一只读文件句柄读取并复核大小与 SHA-256，直接返回这次通过校验的字节；运行中被替换、截断或删除的文件返回 404，并从可安装目录移除，避免下载内容与登记哈希不一致。

小剧场 JSON 沿用 `{ "name": "日常小剧场", "scenes": [{ "main": "主角台词", "companion": "搭子台词" }, ...] }`，需要 3–5 组非空文字对白，兼容 `actorA` / `actorB` 字段。互动词库沿用 `{ "reactions": { "idle": ["你好"], "happy": ["今天真不错"] } }`，也支持 `words` 包装或直接动作对象，兼容现有中文动作别名。每个 JSON 必须包含当前分类能识别的内容；Windows 安装器沿用原解析器规范化名称、台词长度和单动作台词数量。
