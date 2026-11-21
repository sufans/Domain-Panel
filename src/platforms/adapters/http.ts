import { PlatformError, redactPlatformSecrets } from "../types";
import { listPlatformDefinitions } from "../registry";

export async function requestJson<T>(
  url: string,
  init: RequestInit = {},
  secretValues: Array<string | null | undefined> = []
): Promise<T> {
  const parsed = new URL(url);
  const safe = (message: string) => redactPlatformSecrets(message, secretValues);
  const allowed = listPlatformDefinitions().some((definition) => definition.upstreamHosts.includes(parsed.hostname));
  if (!allowed) throw new PlatformError(`禁止请求未登记的上游主机：${parsed.hostname}`, 400, "upstream_host_not_allowed");
  if (parsed.protocol !== "https:") throw new PlatformError("上游请求必须使用 HTTPS", 400, "upstream_protocol_not_allowed");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      cache: "no-store",
      signal: init.signal ?? controller.signal
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new PlatformError(`上游返回重定向（HTTP ${response.status}），已拒绝跟随`, 502, "upstream_redirect");
    }
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text.trim() ? JSON.parse(text) : null;
    } catch {
      throw new PlatformError(safe(`上游返回了非 JSON 响应（HTTP ${response.status}）`), response.status, "invalid_response");
    }
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "message" in payload ? String((payload as { message?: unknown }).message) : `上游请求失败（HTTP ${response.status}）`;
      throw new PlatformError(safe(message), response.status, "upstream_error");
    }
    return payload as T;
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    if (
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError")
    ) throw new PlatformError("上游请求超时", 504, "timeout");
    throw new PlatformError(safe(error instanceof Error ? error.message : "上游网络请求失败"), 502, "network_error");
  } finally {
    clearTimeout(timeout);
  }
}
