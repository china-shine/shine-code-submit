// 注册 plugin 到三处 JSON:known_marketplaces + installed_plugins + settings.enabledPlugins。
// 关键:directory marketplace 的 plugin 不会自动进 settings.enabledPlugins(bug #17832),
// 必须 install 脚本显式写 settings.json,否则 plugin 文件在但 hook 不生效。
import { readJsonDefault, writeJsonAtomicWithBackup } from "./json-safe";
import { installedPluginsPath, knownMarketplacesPath, settingsPath } from "./paths";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "./deploy";
import { SERVICE_VERSION } from "../shared/config";
import { info, warn } from "./log";

/* eslint-disable @typescript-eslint/no-explicit-any -- claude 的 JSON 结构是动态的,用 any 最直接 */

function pluginKey(): string {
  return `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
}

/** 注册 marketplace(directory source)。幂等。
 *  source.path 与 installLocation 都指 cachePath(marketplace 根,含 .claude-plugin/marketplace.json)。
 *  不能指 .claude-plugin 子目录:Claude Code 按 installLocation/.claude-plugin/marketplace.json 读清单,
 *  且 plugin source "./" 相对根解析。指 .claude-plugin 子目录会报 "Plugin X not found in marketplace Y"
 *  (实测 Claude Code 2.1.123)。也不能用 ~/.claude/plugins/marketplaces/<name>——那目录我们没填,是空的。 */
export function registerMarketplace(cachePath: string): void {
  const file = knownMarketplacesPath();
  const data = readJsonDefault<Record<string, any>>(file, {});
  const existing = data[MARKETPLACE_NAME];
  if (existing?.source && existing.source.source !== "directory") {
    warn(
      `[shine-code-submit] WARNING: marketplace "${MARKETPLACE_NAME}" 已存在(source=${existing.source.source}),将覆盖为 directory 源(原文件已备份)`,
    );
  }
  data[MARKETPLACE_NAME] = {
    source: { source: "directory", path: cachePath },
    installLocation: cachePath,
    lastUpdated: new Date().toISOString(),
    autoUpdate: false,
  };
  writeJsonAtomicWithBackup(file, data);
  info(`[shine-code-submit] marketplace 已注册 → ${file}`);
}

/** 注册 plugin 到 installed_plugins.json(version 2 结构)。幂等。 */
export function registerPlugin(cachePath: string): void {
  const file = installedPluginsPath();
  const data = readJsonDefault<{ version?: number; plugins?: Record<string, any[]> }>(file, {
    version: 2,
    plugins: {},
  });
  if (!data.version) data.version = 2;
  if (!data.plugins) data.plugins = {};
  const key = pluginKey();
  const now = new Date().toISOString();
  const existing = data.plugins[key]?.[0];
  data.plugins[key] = [
    {
      scope: "user",
      installPath: cachePath,
      version: SERVICE_VERSION,
      installedAt: existing?.installedAt ?? now,
      lastUpdated: now,
    },
  ];
  writeJsonAtomicWithBackup(file, data);
  info(`[shine-code-submit] plugin 已注册 → ${file}`);
}

/** 启用 plugin:写 settings.json 的 enabledPlugins + extraKnownMarketplaces。幂等。解 #17832。 */
export function enablePlugin(cachePath: string): void {
  const file = settingsPath();
  const data = readJsonDefault<Record<string, any>>(file, {});
  if (!data.enabledPlugins) data.enabledPlugins = {};
  const key = pluginKey();
  data.enabledPlugins[key] = true;

  if (!data.extraKnownMarketplaces) data.extraKnownMarketplaces = {};
  if (!data.extraKnownMarketplaces[MARKETPLACE_NAME]) {
    data.extraKnownMarketplaces[MARKETPLACE_NAME] = {
      source: { source: "directory", path: cachePath },
    };
  }
  writeJsonAtomicWithBackup(file, data);
  info(`[shine-code-submit] 已启用(enabledPlugins)→ ${file}`);
}

/** 反注册:从三处 JSON 移除条目。幂等。 */
export function unregisterAll(): void {
  const key = pluginKey();

  const km = readJsonDefault<Record<string, any>>(knownMarketplacesPath(), {});
  if (km[MARKETPLACE_NAME]) {
    delete km[MARKETPLACE_NAME];
    writeJsonAtomicWithBackup(knownMarketplacesPath(), km);
  }

  const ip = readJsonDefault<{ plugins?: Record<string, any[]> }>(installedPluginsPath(), { plugins: {} });
  if (ip.plugins && ip.plugins[key]) {
    delete ip.plugins[key];
    writeJsonAtomicWithBackup(installedPluginsPath(), ip);
  }

  const s = readJsonDefault<Record<string, any>>(settingsPath(), {});
  let changed = false;
  if (s.enabledPlugins && s.enabledPlugins[key]) {
    delete s.enabledPlugins[key];
    changed = true;
  }
  if (s.extraKnownMarketplaces && s.extraKnownMarketplaces[MARKETPLACE_NAME]) {
    delete s.extraKnownMarketplaces[MARKETPLACE_NAME];
    changed = true;
  }
  if (changed) writeJsonAtomicWithBackup(settingsPath(), s);
  info("[shine-code-submit] 已从三处 JSON 移除注册");
}
