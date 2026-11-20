# 多平台适配器

平台适配器位于 `src/platforms/`，由 `src/platforms/registry.ts` 注册。新增平台不需要修改 D1 的 `accounts.provider` 字段约束。

## 统一接口

- `GET /api/platforms`：返回平台名称、凭证字段、能力矩阵、限流窗口和上游主机白名单。
- `GET /api/unified/domains`：跨账号实时读取统一域名模型。
- `GET /api/unified/records/:accountId/:domainId`：读取统一解析记录。
- `POST/PUT/DELETE /api/unified/records/...`：记录增删改。
- `POST /api/unified/records/batch`：批量删除、状态、TTL 和线路操作；平台不支持时返回 `unsupported_batch_operation`。

统一模型保留 `platform`、本地 `accountId`、上游对象 `id` 和 `raw` 原始响应，平台特有字段不丢失。

## 已注册平台

| 标识 | 凭证 | 统一能力 | 上游主机 |
| --- | --- | --- | --- |
| `dnshe` | API Key + API Secret | 域名、记录、注册、续期、配额 | `api005.dnshe.com` |
| `cloudflare` | API Token | Zone、记录、配额 | `api.cloudflare.com` |
| `dnsneko` | Username + API Key | 域名、记录、批量记录 | `www.dnsneko.com` |
| `gleam` | API Key | 子域名、记录 | `sld.0n.pub` |

## 新增平台步骤

1. 在 `src/platforms/types.ts` 扩展 `PlatformId` 和必要能力。
2. 在 `src/platforms/registry.ts` 增加平台定义、凭证字段、限流和主机白名单。
3. 新增 `src/platforms/adapters/<platform>.ts`，实现 `PlatformAdapter`。
4. 在 `src/platforms/index.ts` 注册适配器。
5. 为认证头、分页、字段映射、错误和不支持能力添加脱敏夹具测试。

凭证只在服务端从 D1 解密并使用；账号列表、日志和平台元数据接口均不返回明文密钥。

 ## 统一 API 路由

 平台记录操作同时挂载 `/api/unified/records/...` 与 `/api/records/...` 两条路径，前端可按习惯选用。

 - `GET /api/domains/:accountId/:domainId`：返回单个域名的统一模型详情，由统一路由抽取并缓存，不与 `/dns`、`/propagation` 等旧路径冲突。
 - `POST /api/accounts/:id/check`：只读连接检测，返回 `{ ok, platform, alias, identity, checked_at }`，不写日志凭据，不返回 Secret。

 ## 平台定义字段

 除能力矩阵外，平台定义还支持：

 - `recordTypes?: string[]`：上游允许的记录类型白名单。缺省表示不限。例如 GLEAM 只允许 `A / AAAA / CNAME / TXT`，前端据此裁剪下拉列表。

 ## 错误码

 | 错误码 | 含义 |
 | --- | --- |
 | `unsupported_operation` | 该平台不支持此操作（能力矩阵检查） |
 | `unsupported_batch_operation` | 该平台不支持批量操作（`batchOperation` 未实现） |
 | `unsupported_record_type` | 提交的记录类型不在 `recordTypes` 白名单内，未到达上游 |
 | `unsupported_platform` | 平台 ID 未注册 |

 ## 安全边界

 - 凭证只在服务端解密使用。`GET /api/accounts` 对 DNSNEKO / GLEAM 旧布局输出 `dnsneko:legacy:<sha256 前 12 字节>` 指纹，不泄露明文密钥。
 - 前端通过 `POST /api/accounts/:id/check` 验证凭据有效性，不接触原始 Secret。
 - 新增平台只需扩展 `PlatformId`、注册定义、实现 `PlatformAdapter`、添加测试夹具，不修改数据库 `CHECK` 约束或聚合路由。
