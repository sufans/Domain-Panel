/**
 * 四平台统一契约测试：合成上游响应，不触网、不使用真实凭据。
 *
 * 覆盖：认证头、分页、字段映射、错误转换、GLEAM 幂等头与不支持批量、
 * DNSNEKO 19 位雪花 ID 不被 Number() 改写、账号接口不泄漏明文密钥。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  stdin: {
    contents: `export {default as worker} from './src/index'; export {createD1FromSqlite} from './server/d1-sqlite'; export {DatabaseManager,encryptText} from './src/db';`,
    resolveDir: repo
  },
  bundle: true, write: false, platform: "node", target: "node22", format: "esm", external: ["cloudflare:sockets"]
});
const source = `${bundle.outputFiles[0].text}\n//# sourceURL=synthetic-platform-contracts.bundle.mjs`;
const { worker, createD1FromSqlite, DatabaseManager, encryptText } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

const originalFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ADMIN_TOKEN = "synthetic-admin-token-for-contracts";
const AES_KEY = "synthetic-aes-key-for-contracts";
const NEKO_DOMAIN_ID = "2052027056887279618";
const NEKO_RECORD_ID = "2052271199416860674";

let passed = 0;
let failed = 0;

async function harness(accounts, upstream, run) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(path.join(repo, "schema.sql"), "utf8"));
  const DB = createD1FromSqlite(sqlite);
  const env = { DB, AES_KEY, ADMIN_TOKEN };
  const manager = new DatabaseManager(DB, AES_KEY);
  await manager.ensureTables();
  for (const account of accounts) {
    sqlite.prepare("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(?,?,?,?,?)").run(
      account.id,
      account.alias,
      account.apiKey,
      await encryptText(account.secret, AES_KEY),
      account.provider
    );
  }
  const calls = [];
  const tasks = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { url, method: init.method || "GET", headers: new Headers(init.headers), body: init.body, signal: init.signal };
    calls.push(call);
    return upstream(call);
  };
  const request = async (route, options = {}) => {
    const response = await worker.fetch(
      new Request(`https://synthetic.invalid${route}`, {
        method: options.method || "GET",
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      }),
      env,
      { waitUntil(task) { tasks.push(task); }, passThroughOnException() {} }
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    await run({ request, calls, sqlite, env, tasks });
  } finally {
    await Promise.allSettled(tasks);
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
}

async function test(name, run) {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

const nekoAccount = {
  id: 11, alias: "NEKO 合成账号", provider: "dnsneko",
  apiKey: "dnsneko:synthetic-user", secret: "synthetic-neko-key"
};
const gleamAccount = {
  id: 21, alias: "GLEAM 合成账号", provider: "gleam",
  apiKey: "gleam:synthetic-fingerprint", secret: "hl6_synthetic_key"
};
/** 早期版本把真实密钥写进了 api_key 列，这段布局仍可能留在线上库里。 */
const legacyNekoAccount = {
  id: 31, alias: "NEKO 旧布局账号", provider: "dnsneko",
  apiKey: "synthetic-legacy-neko-key", secret: "synthetic-legacy-user"
};

await test("DNSNEKO 认证头、分页与字段映射", async () => {
  await harness([nekoAccount], (call) => {
    assert.equal(call.url.hostname, "www.dnsneko.com");
    assert.equal(call.headers.get("X-DNSNEKO-USERNAME"), "synthetic-user");
    assert.equal(call.headers.get("X-DNSNEKO-API-KEY"), "synthetic-neko-key");
    const page = call.url.searchParams.get("page");
    return json({
      code: 200,
      message: "success",
      data: {
        domains: [{ id: NEKO_DOMAIN_ID, domain: "neko.example.com", status: 0, expired: false, expireTime: "2027-05-06T22:05:50", recordCount: "2", createTime: "2026-04-26T20:33:28" }],
        total: "1", size: "100", current: page, pages: "2"
      }
    });
  }, async ({ request, calls }) => {
    const result = await request("/api/unified/domains?provider=dnsneko");
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.success, true);
    assert.equal(result.body.domains.length, 2, "two pages should be aggregated");
    const domain = result.body.domains[0];
    assert.equal(domain.id, NEKO_DOMAIN_ID, "snowflake id must stay a string");
    assert.equal(domain.platform, "dnsneko");
    assert.equal(domain.accountId, nekoAccount.id);
    assert.equal(domain.recordCount, 2);
    assert.equal(calls.length, 2, "should follow pages=2");
    assert.equal(calls[1].url.searchParams.get("page"), "2");
  });
});

await test("DNSNEKO 记录读取补全分页", async () => {
  await harness([nekoAccount], (call) => {
    assert.ok(call.url.pathname.endsWith("/records"));
    return json({
      code: 200,
      data: {
        records: [{
          id: call.url.searchParams.get("page") === "1" ? NEKO_RECORD_ID : "2052271199416860675",
          name: "www", type: "A", value: "192.0.2.10", line: "default", ttl: 600, priority: null, status: 1, updateTime: null
        }],
        total: "2", size: "100", pages: "2"
      }
    });
  }, async ({ request }) => {
    const result = await request(`/api/unified/records/${nekoAccount.id}/${NEKO_DOMAIN_ID}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.records.length, 2);
    assert.equal(result.body.records[0].status, "active");
    assert.equal(result.body.platform, "dnsneko");
  });
});

await test("DNSNEKO 批量请求保留原始 19 位 ID", async () => {
  await harness([nekoAccount], (call) => {
    assert.equal(call.method, "POST");
    assert.ok(call.url.pathname.endsWith("/records/batch/status"));
    return json({ code: 200, data: null });
  }, async ({ request, calls }) => {
    const result = await request("/api/unified/records/batch", {
      method: "POST",
      body: { account_id: nekoAccount.id, domain_id: NEKO_DOMAIN_ID, operation: "status", ids: [NEKO_RECORD_ID], value: false }
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.count, 1);
    assert.equal(calls[0].body, `{"domainId":${NEKO_DOMAIN_ID},"ids":[${NEKO_RECORD_ID}],"status":0}`);
  });
});

await test("GLEAM 幂等头、创建不带 TTL、字段映射", async () => {
  await harness([gleamAccount], (call) => {
    assert.equal(call.url.hostname, "sld.0n.pub");
    assert.equal(call.headers.get("X-API-Key"), "hl6_synthetic_key");
    if (call.method !== "GET") assert.match(call.headers.get("X-Idempotency-Key") || "", /^[0-9a-f-]{36}$/);
    if (call.url.pathname.endsWith("/subdomains")) {
      return json({ code: 0, data: [{ id: 42, fqdn: "demo.example.com", status: "active", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", dns_records: [{ id: 1 }] }] });
    }
    return json({ code: 0, data: { id: 5, subdomain_id: 42, type: "A", name: "demo.example.com", content: "203.0.113.10", ttl: 1, provider_record_id: "x", status: "active", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" } }, 201);
  }, async ({ request, calls }) => {
    const domains = await request("/api/unified/domains?provider=gleam");
    assert.equal(domains.status, 200, JSON.stringify(domains.body));
    assert.equal(domains.body.domains[0].id, "42");
    assert.equal(domains.body.domains[0].name, "demo.example.com");
    assert.equal(domains.body.domains[0].recordCount, 1);

    const created = await request(`/api/unified/records/${gleamAccount.id}/42`, {
      method: "POST",
      body: { name: "demo", type: "A", content: "203.0.113.10", ttl: 600 }
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const createCall = calls.find((call) => call.method === "POST");
    const payload = JSON.parse(createCall.body);
    assert.deepEqual(payload, { type: "A", content: "203.0.113.10" }, "GLEAM rejects client supplied TTL");
  });
});

await test("GLEAM 不支持批量操作返回稳定错误码", async () => {
  await harness([gleamAccount], () => json({ code: 0, data: [] }), async ({ request }) => {
    const result = await request("/api/unified/records/batch", {
      method: "POST",
      body: { account_id: gleamAccount.id, domain_id: "42", operation: "delete", ids: ["5"] }
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error_code, "unsupported_operation");
  });
});

await test("旧布局账号列表也不返回明文密钥", async () => {
  await harness([legacyNekoAccount], () => json({ code: 200, data: null }), async ({ request }) => {
    const result = await request("/api/accounts");
    assert.equal(result.status, 200);
    const serialized = JSON.stringify(result.body);
    assert.ok(!serialized.includes("synthetic-legacy-neko-key"), "legacy DNSNEKO key must not leak");
    assert.match(result.body.accounts[0].api_key, /^dnsneko:legacy:[0-9a-f]{24}$/);

    // 凭据读取仍要能还原旧布局：username 来自加密列，apiKey 来自 api_key 列。
    const checked = await request(`/api/accounts/${legacyNekoAccount.id}/check`, { method: "POST" });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.identity, "synthetic-legacy-user");
  });
});

await test("账号列表不返回明文密钥", async () => {
  await harness([], (call) => {
    if (call.url.pathname.endsWith("/user/info")) return json({ code: 0, data: { id: 7, name: "合成 GLEAM 用户", email: null } });
    if (call.url.pathname.endsWith("/domains")) return json({ code: 200, data: { domains: [], total: "0", pages: "1" } });
    return json({ code: 0, data: [] });
  }, async ({ request }) => {
    const neko = await request("/api/accounts", { method: "POST", body: { provider: "dnsneko", alias: "NEKO 绑定", username: "synthetic-user", api_key: "synthetic-neko-key" } });
    assert.equal(neko.status, 200, JSON.stringify(neko.body));
    const gleam = await request("/api/accounts", { method: "POST", body: { provider: "gleam", alias: "GLEAM 绑定", api_key: "hl6_synthetic_key" } });
    assert.equal(gleam.status, 200, JSON.stringify(gleam.body));

    const result = await request("/api/accounts");
    assert.equal(result.status, 200);
    const serialized = JSON.stringify(result.body);
    assert.ok(!serialized.includes("synthetic-neko-key"), "DNSNEKO key must not leak");
    assert.ok(!serialized.includes("hl6_synthetic_key"), "GLEAM key must not leak");
    const nekoRow = result.body.accounts.find((item) => item.provider === "dnsneko");
    const gleamRow = result.body.accounts.find((item) => item.provider === "gleam");
    assert.equal(nekoRow.api_key, "dnsneko:synthetic-user");
    assert.match(gleamRow.api_key, /^gleam:[0-9a-f]{24}$/);
    assert.equal(gleamRow.alias, "GLEAM 绑定");
  });
});

await test("平台注册表不泄漏密钥且四平台齐全", async () => {
  await harness([], () => json({ code: 200, data: null }), async ({ request }) => {
    const result = await request("/api/platforms");
    assert.equal(result.status, 200);
    const ids = result.body.platforms.map((platform) => platform.id).sort();
    assert.deepEqual(ids, ["cloudflare", "dnshe", "dnsneko", "gleam"]);
    assert.ok(!JSON.stringify(result.body).includes("secret-value"));
    const gleam = result.body.platforms.find((platform) => platform.id === "gleam");
    assert.deepEqual(gleam.recordTypes, ["A", "AAAA", "CNAME", "TXT"], "GLEAM 的记录类型上限必须下发到前端");
  });
});

await test("/api/records 短路径与 /api/unified/records 行为一致", async () => {
  await harness([nekoAccount], () => json({
    code: 200,
    data: { records: [{ id: NEKO_RECORD_ID, name: "@", type: "A", value: "192.0.2.10", line: "default", ttl: 600, priority: null, status: 1, updateTime: null }], total: "1", pages: "1" }
  }), async ({ request }) => {
    const short = await request(`/api/records/${nekoAccount.id}/${NEKO_DOMAIN_ID}`);
    const long = await request(`/api/unified/records/${nekoAccount.id}/${NEKO_DOMAIN_ID}`);
    assert.equal(short.status, 200, JSON.stringify(short.body));
    assert.deepEqual(short.body, long.body);
  });
});

await test("/api/domains/:accountId/:domainId 返回单个域名详情", async () => {
  await harness([nekoAccount], () => json({
    code: 200,
    data: { domains: [{ id: NEKO_DOMAIN_ID, domain: "neko.example.com", status: 0, expired: false, expireTime: "2027-05-06T22:05:50", recordCount: "1" }], total: "1", pages: "1" }
  }), async ({ request }) => {
    const found = await request(`/api/domains/${nekoAccount.id}/${NEKO_DOMAIN_ID}`);
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.equal(found.body.domain.name, "neko.example.com");
    const missing = await request(`/api/domains/${nekoAccount.id}/9999999999999999999`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error_code, "domain_not_found");
  });
});

await test("GLEAM 拒绝不支持的记录类型且末调用上游", async () => {
  await harness([gleamAccount], () => json({ code: 0, data: null }), async ({ request, calls }) => {
    const result = await request(`/api/unified/records/${gleamAccount.id}/42`, {
      method: "POST",
      body: { name: "@", type: "MX", content: "10 mail.example.com" }
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error_code, "unsupported_record_type");
    assert.equal(calls.length, 0, "invalid type must be rejected before any upstream call");
  });
});

await test("未登录不能调用平台与账号接口", async () => {
  await harness([], () => json({ code: 200, data: null }), async ({ env }) => {
    const response = await worker.fetch(new Request("https://synthetic.invalid/api/platforms"), env, {
      waitUntil() {},
      passThroughOnException() {}
    });
    assert.equal(response.status, 401);
  });
});

console.log(`\nplatform contracts: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
