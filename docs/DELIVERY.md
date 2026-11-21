# 当前交付

## 当前状态

2026-11-03：issue #3 的上游错误分类与绑定校验修复已推送；用户随后针对自用实例注册 403 明确授权添加诊断、部署生产，并尝试一个指定域名。注册路径现保留 HTTP 状态、错误码、接口与 Ray ID，失败写脱敏日志，不再丢失 V2 错误信息。生产后端诊断已部署，前端资源指纹与原版一致，D1/KV/AES Secret/定时配置未变，无数据库迁移。未直接评论或关闭 issue。排查与回复草稿见 [issue #3](issues/3-account-binding-520.md)。

实网对照：同一账号凭据由本地进程调用 WHOIS/配额成功，经 Workers HKG 路径调用 WHOIS/配额/注册时返回上游 520。指定域名只提交一次注册请求，之后通过独立只读查询确认仍未注册、配额未变。原截图 403 未重现，不能断言其与本次 520 的具体原因相同；报告者的网络问题也没有被宣称已修复。域名、账号与完整实网证据只留在仓库外。

本轮绑定/注册诊断定向回归为 23/23（初版绑定 15 项，新增注册 8 项）。阶段回归：委派 16/16、预览隔离 9/9、鉴权日志 6/6、续期规则 8/8、SQLite 22/22、local KV 4/4、用量后端 22/22（含本地 workerd）通过；Worker/Node 类型检查、Node 构建和生产前端构建通过。自动化回归的外部 API 均为合成夹具；上一段明确授权的实网注册尝试是独立证据，不能混为自动化测试。未改前端，也未将旧截图当作本轮实网复现证据。

## 已发布基线

2026-10-22：修复注册后缓存延迟与自动续期边界，并新增独立“自动续期”工作页。注册后对上游列表做有界重试，仍未出现时通过 Worker waitUntil 继续后台重试，前端轮询本地缓存并明确显示待同步；续期成功但缺少 `new_expires_at` 不再覆盖本地旧值，已过期域名进入候选，缺少到期时间仍保持未知。本轮源码、README 与 Release 说明已整理，生产实例不重复部署。

新增定向回归：`npm run test:renewal:rules`（8/8），覆盖缺失日期、进入阈值、越过阈值、已过期及续期响应缺失字段。委派 16/16、SQLite 22/22、local KV 4/4、登录审计 6/6、预览隔离 9/9、注册/DDNS 16/16 均通过；前后端构建均通过。Pages 13/13 路由及续期三模式×两宽度通过，无外部请求和页面/控制台错误，六张深色截图已目视。真实域名注册／续期写入未执行。

2026-10-20：一键委派已改用 Cloudflare 绑定中的真实 Account ID，不再传面板账号主键。缺失标识、快照未确认、已有 Zone 归属不符或不唯一时中止，避免误修改 DNSHE 记录；客户端也校验 Account ID 格式。本轮无数据库迁移、前端改动或额外账号读取权限。

定向回归：`npm run test:delegate:cf`，真实 Worker 路由、内存 SQLite、合成外部服务 16/16 通过。另已通过 Worker／Node 类型检查、Node 构建、SQLite 22/22、local KV 4/4、权限合同 3/3、用量后端 22/22（含 workerd）、预览隔离 9/9、登录审计 6/6。真实 Cloudflare 建 Zone、DNSHE 写 NS 和公网激活不属于本轮生产只读验收；不得以离线通过宣称实际委派已完成。

注册页已加入账号配额选择约束：账号选项内显示已用／剩余或用尽状态，不额外添加规则备注；已用尽账号不可选，未知或读取失败保持独立语义，全部用尽时禁止提交。定向回归为 `npm run test:register-ddns:ui`，包含选择框与注册按钮对齐检查。

本仓库当前交付为**可直接部署的产品源码**：Worker 与 Node 自建版保留完整 API、D1/KV、认证和业务逻辑，部署时使用操作者自己的资源配置。

## Node 自建版助力缓存

Node 自建版在没有 Cloudflare KV 时使用 SQLite-backed local KV：

- 启动时自动把本地 KV 注入 `ASSIST_KV`；
- 数据写入自建版 SQLite，并随挂载的 `/data` 目录持久化；
- 不需要为 Node 自建版额外创建 Cloudflare KV；
- Cloudflare Workers 仍按自己的 `wrangler.toml` 配置 `ASSIST_KV` namespace。

相关回归：

```powershell
npm run test:local-kv
npm run build:node
npm run verify:node
```

## 验收边界

- 前端构建与后端构建分别验证；前端产物不含演示会话。
- 业务写入、登录会话、数据库、KV 和外部凭据只存在于操作者自己的部署。
- 真实部署前应复制 `.env.example`，创建自己的 D1/KV，注入自己的密钥，并在隔离环境完成读写验证。
- 前端界面回归使用合成数据；任何真实账号验收都应明确限定为只读并与日用实例隔离。

## 当前验证命令

```powershell
git diff --check
npm run test:delegate:cf
npm run test:renewal:rules
npm run test:accounts:binding
npm run test:local-kv
npm run build:node
npm run verify:node
npm --prefix frontend run build:selfhost
```

## 2026-11-10：多平台 DNS 聚合管理（DNSHE / Cloudflare / DNSNEKO / GLEAM）

 以 DNSHE-Panel 的 Workers + D1 + KV 架构为基础，将平台调用重构为代码插件注册机制，四平台统一接入。

### 平台注册表与适配器

 - `src/platforms/registry.ts`：声明平台名称、凭证字段、能力矩阵、`recordTypes` 白名单、上游主机和限流参数。
 - `src/platforms/types.ts`：统一 DTO（`PlatformId`、`UnifiedDomain`、`UnifiedRecord`、`PlatformCredentials`、`PlatformAdapter`）与错误类型。
 - `src/platforms/adapters/dnsneko.ts` / `gleam.ts`：DNSNEKO（含 19 位雪花 ID 字符串保留）和 GLEAM（含幂等头、无 TTL、记录类型白名单）的适配器。

### 统一 API 路由

 - `GET /api/platforms`：动态返回平台能力矩阵（前端不再硬编码平台列表）。
 - `GET /api/unified/domains`：跨平台实时聚合域名，单个账号失败不拖垮整张表。
 - `GET /api/domains/:accountId/:domainId`：返回单个域名详情。
 - `GET/POST/PUT/DELETE /api/unified/records/...` 与 `/api/records/...`（双路径）：记录 CRUD。
 - `POST /api/unified/records/batch`：批量删除/状态/TTL/线路操作；不支持时返回 `unsupported_batch_operation`。
 - `POST /api/accounts/:id/check`：只读连接检测。

### 前端兼容

 - `UnifiedPlatformAssets.tsx`：DNSNEKO / GLEAM 实时资产卡片（不在 D1 快照中），含筛选、记录面板、按平台裁剪的表单。
 - `EditorialViews.tsx`：四平台账号看板，新平台显示「操作范围」而非「资源快照」。
 - `SourceMappedOverview.tsx`：概览卡片四平台。
 - `App.tsx`：概览身份条、账号页分区、域名页实时资产挂载均支持四平台；后端不可用时 `effectivePlatformDefinitions` 兜底。

### 安全与兼容

 - 旧布局（api_key 存密钥、api_secret 存 username）输出指纹 `dnsneko:legacy:<sha256 前 12 字节>`，不泄露明文。
 - GLEAM 非法类型在调上游前拒绝（`unsupported_record_type`）。
 - WHOIS 路由改为显式 `provider === "dnshe"` 而非 `!== "cloudflare"`。

### 验证结果

 - 契约测试 12/12 通过（认证头、字段映射、旧布局指纹、批量错误、类型白名单、短路径等）。
 - 类型检查：根 + frontend 均 0 错误。
 - Vite 构建通过。
 - 浏览器验收：8 路由无溢出/错误/外网；设计风四平台账号分组 + 7 行；GLEAM 表单仅 A/AAAA/CNAME/TXT；390px 不溢出。
 - 回归测试：CF 配额 23/23、概览 CF 5/5、续期规则 8/8、域名检查缓存 10/10 均通过。
 - `git diff --check`：无空白错误。

 新增平台步骤：扩展 `PlatformId` → 注册定义 → 实现 `PlatformAdapter` → 测试夹具 → 前端自动适配。
