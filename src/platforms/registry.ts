import type { PlatformAdapter, PlatformDefinition, PlatformId } from "./types";
import { PlatformError } from "./types";

const definitions: Record<PlatformId, PlatformDefinition> = {
  dnshe: {
    id: "dnshe",
    name: "DNSHE",
    description: "DNSHE 子域名、解析记录、注册与续期管理",
    credentialFields: [
      { key: "api_key", label: "API Key", required: true },
      { key: "api_secret", label: "API Secret", required: true, secret: true }
    ],
    capabilities: ["domains.read", "records.read", "records.create", "records.update", "records.delete", "domains.register", "domains.renew", "quota.read"],
    upstreamHosts: ["api005.dnshe.com"],
    rateLimit: { requests: 55, windowSeconds: 60 }
  },
  cloudflare: {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Cloudflare Zone、DNS 记录和账户资源管理",
    credentialFields: [{ key: "api_token", label: "API Token", required: true, secret: true }],
    capabilities: ["domains.read", "records.read", "records.create", "records.update", "records.delete", "zones.manage", "quota.read"],
    upstreamHosts: ["api.cloudflare.com"],
    rateLimit: { requests: 40, windowSeconds: 60 }
  },
  dnsneko: {
    id: "dnsneko",
    name: "DNSNEKO",
    description: "DNSNEKO 域名、解析记录和批量 DNS 操作",
    credentialFields: [
      { key: "username", label: "Username", required: true },
      { key: "api_key", label: "API Key", required: true, secret: true }
    ],
    capabilities: ["domains.read", "records.read", "records.create", "records.update", "records.delete", "records.batch"],
    upstreamHosts: ["www.dnsneko.com"],
    rateLimit: { requests: 28, windowSeconds: 60 }
  },
  gleam: {
    id: "gleam",
    name: "GLEAM",
    description: "GLEAM 子域名和解析记录管理",
    credentialFields: [{ key: "api_key", label: "API Key", required: true, secret: true, placeholder: "hl6_xxxxxxxxxxxx" }],
    capabilities: ["domains.read", "records.read", "records.create", "records.update", "records.delete"],
    // 上游文档：创建只接受 A / AAAA / CNAME / TXT，TTL 由服务商自动决定，类型创建后不可改。
    recordTypes: ["A", "AAAA", "CNAME", "TXT"],
    upstreamHosts: ["sld.0n.pub"],
    rateLimit: { requests: 55, windowSeconds: 60 }
  }
};

const adapters = new Map<PlatformId, PlatformAdapter>();

export function listPlatformDefinitions(): PlatformDefinition[] {
  return Object.values(definitions).map((definition) => ({
    ...definition,
    credentialFields: definition.credentialFields.map((field) => ({ ...field })),
    capabilities: [...definition.capabilities],
    ...(definition.recordTypes ? { recordTypes: [...definition.recordTypes] } : {}),
    upstreamHosts: [...definition.upstreamHosts]
  }));
}

export function getPlatformDefinition(id: string): PlatformDefinition {
  const definition = definitions[id as PlatformId];
  if (!definition) throw new PlatformError(`不支持的平台：${id}`, 400, "unsupported_platform");
  return definition;
}

export function registerPlatformAdapter(adapter: PlatformAdapter): void {
  if (!definitions[adapter.platform]) throw new PlatformError(`平台未注册：${adapter.platform}`, 500, "platform_not_registered");
  adapters.set(adapter.platform, adapter);
}

export function getPlatformAdapter(id: PlatformId): PlatformAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new PlatformError(`平台适配器未加载：${id}`, 500, "adapter_not_loaded");
  return adapter;
}

export function assertPlatformCredentials(id: PlatformId, credentials: Record<string, unknown>): void {
  const definition = getPlatformDefinition(id);
  for (const field of definition.credentialFields.filter((item) => item.required)) {
    const value = credentials[field.key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new PlatformError(`${definition.name} 缺少 ${field.label}`, 400, "invalid_credentials");
    }
  }
}
