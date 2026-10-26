// User settings for the terminal app (written by `skck --setup`).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { LevelSchema } from "../shared/schemas.js";
import { defaultDataDir } from "../storage/jsonStore.js";

export const ConfigSchema = z.object({
  level: LevelSchema.default("beginner"),
  agent: z.enum(["claude", "codex"]).default("claude"),
  /** Claude Code model alias (haiku is fastest). */
  claudeModel: z.enum(["haiku", "sonnet", "opus"]).default("haiku"),
  /** Let Claude use extended thinking (slower). */
  claudeThinking: z.boolean().default(false),
  /** Ollama tag for Gemma; empty = first installed gemma*. */
  gemmaModel: z.string().default(""),
  /** Let Gemma reason step by step and show it (much slower). Off still shows its answer live as it's written. */
  showThinking: z.boolean().default(false),
  /** Claude edits and runs commands without asking. */
  autoPermissions: z.boolean().default(true),
});
export type Config = z.infer<typeof ConfigSchema>;

export const configPath = () => join(defaultDataDir(), "config.json");

export function loadConfig(): Config {
  try {
    if (existsSync(configPath())) return ConfigSchema.parse(JSON.parse(readFileSync(configPath(), "utf8")));
  } catch {
    /* fall back to defaults */
  }
  return ConfigSchema.parse({});
}

export function saveConfig(c: Config): void {
  mkdirSync(defaultDataDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(c, null, 2));
}

/** Engine/agent environment derived from the settings. */
export function applyConfigEnv(c: Config): void {
  process.env.LCC_CLAUDE_MODEL = c.claudeModel;
  process.env.LCC_CLAUDE_THINKING = c.claudeThinking ? "1" : "0";
  process.env.LCC_GEMMA_THINK = c.showThinking ? "low" : "off";
  if (c.gemmaModel) process.env.OLLAMA_MODEL = c.gemmaModel;
}
