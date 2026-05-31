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
  if (file.endsWith(".xcstrings")) return xcstringsAdapter;
  if (file.endsWith(".po")) return poAdapter;
  if (file.endsWith("messages.json") && file.includes("_locales")) return chromeJsonAdapter;
  if (file.endsWith("strings.xml") && file.includes("/res/values")) return androidXmlAdapter;
  if (/config\/locales\/.*\.ya?ml$/.test(file)) return railsYamlAdapter;
  if (file.includes("fastlane/metadata/")) return fastlaneMetadataAdapter;
  return null;
}
