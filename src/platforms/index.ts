import { createDnsNekoAdapter } from "./adapters/dnsneko";
import { createGleamAdapter } from "./adapters/gleam";
import { createCloudflareAdapter, createDnsheAdapter } from "./adapters/legacy";
import { registerPlatformAdapter } from "./registry";

registerPlatformAdapter(createDnsheAdapter());
registerPlatformAdapter(createCloudflareAdapter());
registerPlatformAdapter(createDnsNekoAdapter());
registerPlatformAdapter(createGleamAdapter());

export * from "./types";
export * from "./registry";
