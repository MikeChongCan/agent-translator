import path from "node:path";
import type { Adapter, FormatId } from "../types";
import { androidXmlAdapter } from "./android-xml";
import { chromeJsonAdapter } from "./chrome-json";
import { fastlaneMetadataAdapter } from "./fastlane-metadata";
import { poAdapter } from "./po";
import { railsYamlAdapter } from "./rails-yaml";
import { xcstringsAdapter } from "./xcstrings";

export const adapters: Adapter[] = [
  xcstringsAdapter,
  poAdapter,
  chromeJsonAdapter,
  androidXmlAdapter,
  railsYamlAdapter,
  fastlaneMetadataAdapter,
];

export function adapterForFormat(format: FormatId): Adapter {
  const adapter = adapters.find((candidate) => candidate.format === format);
  if (!adapter) throw new Error(`Unsupported format: ${format}`);
  return adapter;
}

export function adapterForPath(file: string): Adapter | null {
  const normalized = file.split(path.sep).join("/");
  if (normalized.endsWith(".xcstrings")) return xcstringsAdapter;
  if (normalized.endsWith(".po")) return poAdapter;
  if (normalized.endsWith("messages.json") && normalized.includes("_locales")) return chromeJsonAdapter;
  if (normalized.endsWith("strings.xml") && normalized.includes("/res/values")) return androidXmlAdapter;
  if (/config\/locales\/.*\.ya?ml$/.test(normalized)) return railsYamlAdapter;
  if (normalized.includes("fastlane/metadata/")) return fastlaneMetadataAdapter;
  return null;
}
