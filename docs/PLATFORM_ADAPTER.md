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
