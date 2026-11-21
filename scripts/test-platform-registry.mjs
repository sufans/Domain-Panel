import { build } from "esbuild";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const directory = await mkdtemp(join(tmpdir(), "dnshe-platforms-"));
const output = join(directory, "platforms.mjs");
try {
  await build({ entryPoints: ["src/platforms/index.ts"], bundle: true, format: "esm", platform: "neutral", outfile: output, logLevel: "silent" });
  const module = await import(pathToFileURL(output).href);
  const platforms = module.listPlatformDefinitions();
  const ids = platforms.map((platform) => platform.id).sort();
  const expected = ["cloudflare", "dnshe", "dnsneko", "gleam"];
  if (JSON.stringify(ids) !== JSON.stringify(expected)) throw new Error(`平台注册表不完整：${ids.join(",")}`);
  for (const platform of platforms) {
    if (platform.credentialFields.length === 0 || platform.upstreamHosts.length === 0 || platform.capabilities.length === 0) {
      throw new Error(`平台元数据不完整：${platform.id}`);
    }
  }
  console.log(`platform registry ok: ${ids.join(", ")}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
