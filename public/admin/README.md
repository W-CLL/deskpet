# 管理后台前端

浅色现代 SaaS 风格后台，无打包器，由 Express 直出。

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

## 关键接口

- `GET /api/admin/overview`：首页运营/内容/运维 KPI
