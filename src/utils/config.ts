import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentTranslatorConfig, ResolvedConfig } from "../types";
import { readJson } from "./fs";

export async function loadConfig(root: string): Promise<ResolvedConfig> {
  const jsonPaths = ["agent-translator.config.json", ".agent-translator.json"];
  let config: AgentTranslatorConfig = {};

  for (const rel of jsonPaths) {
    const file = path.join(root, rel);
    if (existsSync(file)) {
      config = await readJson<AgentTranslatorConfig>(file);
      break;
    }
  }

  return {
    ...config,
    root,
    sourceLanguage: config.sourceLanguage ?? "en",
    targetLanguages: config.targetLanguages ?? [],
  };
}

export function forbiddenTermsFor(config: ResolvedConfig, language: string, key: string): string[] {
  const terms: string[] = [];
  for (const entry of Object.values(config.glossary ?? {})) {
    if (entry.unlessKeyContains?.some((token) => key.toLowerCase().includes(token.toLowerCase()))) {
      continue;
    }
    terms.push(...(entry.forbidden?.[language] ?? []));
  }
  return terms;
}
