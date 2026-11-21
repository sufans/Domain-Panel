import type { CreateDnsRecordParams, UpdateDnsRecordParams } from "../../dnshe";
import { requestJson } from "./http";
import type { PlatformAdapter, PlatformCredentials, UnifiedDomain, UnifiedRecord } from "../types";
import { PlatformError, redactPlatformSecrets, remainingDays } from "../types";

const BASE = "https://www.dnsneko.com/api/v1/dns";
type NekoResponse<T> = { code: number | string; message?: string; data: T | null };
type NekoDomain = { id: string; domain: string; status: number; expired: boolean; expireTime?: string; recordCount?: string; createTime?: string };
type NekoRecord = { id: string; name: string; type: string; value: string; line: string; ttl: number; priority: number | null; status: number; updateTime: string | null };
type NekoPage<T> = { domains?: NekoDomain[]; records?: NekoRecord[]; total?: string | number; pages?: string | number };

/**
 * 上游 ID 是 19 位雪花号，超过 JS 安全整数范围。
 * JSON.parse/stringify 走 Number 会静默改掉末几位，因此批量请求体直接拼数字字面量，
 * 让上游按 long 精确读取；非纯数字 ID 仍按 JSON 字符串转义。
 */
function rawId(id: string): string {
  return /^\d+$/.test(id) ? id : JSON.stringify(id);
}

function hasNextPage(payload: NekoPage<unknown>, page: number, key: "domains" | "records"): boolean {
  const items = payload[key];
  if (!Array.isArray(items) || items.length === 0) return false;
  const pages = Number(payload.pages);
  if (Number.isFinite(pages) && pages > 0) return page < pages;
  const total = Number(payload.total);
  if (Number.isFinite(total) && total > 0) return page < Math.ceil(total / 100);
  return items.length >= 100;
}

function headers(credentials: PlatformCredentials, json = false): HeadersInit {
  if (!credentials.username || !credentials.apiKey) throw new PlatformError("DNSNEKO 缺少 Username 或 API Key", 400, "invalid_credentials");
  return { "X-DNSNEKO-USERNAME": credentials.username, "X-DNSNEKO-API-KEY": credentials.apiKey, ...(json ? { "Content-Type": "application/json" } : {}) };
}

async function request<T>(credentials: PlatformCredentials, path: string, init: RequestInit = {}): Promise<T> {
  const payload = await requestJson<NekoResponse<T>>(
    `${BASE}${path}`,
    { ...init, headers: { ...headers(credentials, init.body !== undefined), ...(init.headers || {}) } },
    [credentials.apiKey]
  );
  if (String(payload.code) !== "200") {
    const status = Number(payload.code);
    throw new PlatformError(redactPlatformSecrets(payload.message || "DNSNEKO API 调用失败", [credentials.apiKey]), Number.isFinite(status) ? status : 502, "upstream_error");
  }
  return payload.data as T;
}

export function createDnsNekoAdapter(): PlatformAdapter {
  return {
    platform: "dnsneko",
    async verify(credentials) {
      await request<{ domains?: NekoDomain[] }>(credentials, "/domains?page=1&size=1");
      // DNSNEKO 没有独立的「当前用户」接口，认证头里的用户名就是唯一身份。
      return { identity: credentials.username ?? null, alias: credentials.username ?? null };
    },
    async listDomains(credentials, accountId, accountAlias) {
      const domains: NekoDomain[] = [];
      for (let page = 1; page <= 50; page++) {
        const data = await request<NekoPage<NekoDomain>>(credentials, `/domains?page=${page}&size=100`);
        domains.push(...(data.domains || []));
        if (!hasNextPage(data, page, "domains")) break;
      }
      return domains.map((item): UnifiedDomain => ({
        id: item.id, name: item.domain, platform: "dnsneko", accountId, accountAlias,
        status: String(item.status), createdAt: item.createTime || null, expiresAt: item.expireTime || null,
        expired: Boolean(item.expired), remainingDays: remainingDays(item.expireTime), recordCount: item.recordCount ? Number(item.recordCount) : null, raw: item
      }));
    },
    async listRecords(credentials, domainId) {
      const records: NekoRecord[] = [];
      for (let page = 1; page <= 50; page++) {
        const data = await request<NekoPage<NekoRecord>>(credentials, `/records?domainId=${encodeURIComponent(domainId)}&page=${page}&size=100`);
        records.push(...(data.records || []));
        if (!hasNextPage(data, page, "records")) break;
      }
      return records.map((item): UnifiedRecord => ({ id: item.id, domainId, name: item.name, type: item.type, value: item.value, line: item.line || null, ttl: item.ttl, priority: item.priority, status: item.status === 1 ? "active" : "paused", updatedAt: item.updateTime, raw: item }));
    },
    async createRecord(credentials, domainId, input) {
      await request<null>(credentials, `/records/${encodeURIComponent(domainId)}`, { method: "POST", body: JSON.stringify({ name: input.name, type: input.type, value: input.content, line: input.line || "default", ttl: input.ttl, priority: input.priority ?? undefined }) });
      return null;
    },
    async updateRecord(credentials, domainId, recordId, input) {
      await request<null>(credentials, `/records/${encodeURIComponent(domainId)}/${encodeURIComponent(recordId)}`, { method: "PUT", body: JSON.stringify({ name: input.name, type: input.type, value: input.content, line: input.line || "default", ttl: input.ttl, priority: input.priority ?? undefined }) });
      return null;
    },
    async deleteRecord(credentials, domainId, recordId) {
      await request<null>(credentials, `/records/${encodeURIComponent(domainId)}/${encodeURIComponent(recordId)}`, { method: "DELETE" });
    },
    async batchOperation(credentials, domainId, operation, ids, value) {
      if (operation === "ttl" && !(Number.isInteger(Number(value)) && Number(value) > 0)) {
        throw new PlatformError("DNSNEKO 批量修改 TTL 需要正整数秒数", 400, "invalid_ttl");
      }
      if (operation === "line" && !String(value || "").trim()) {
        throw new PlatformError("DNSNEKO 批量修改线路需要线路名称", 400, "invalid_line");
      }
      const fields = [`"domainId":${rawId(domainId)}`, `"ids":[${ids.map(rawId).join(",")}]`];
      if (operation === "status") fields.push(`"status":${value === true || value === 1 ? 1 : 0}`);
      if (operation === "ttl") fields.push(`"ttl":${Number(value)}`);
      if (operation === "line") fields.push(`"line":${JSON.stringify(String(value || "default"))}`);
      await request<null>(credentials, `/records/batch/${operation === "delete" ? "delete" : operation}`, { method: "POST", body: `{${fields.join(",")}}` });
    }
  };
}
