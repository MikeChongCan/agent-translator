import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJob, discoverFiles } from "../src/job";
import { loadConfig } from "../src/utils/config";
import { xcstringsAdapter } from "../src/adapters/xcstrings";
import { poAdapter } from "../src/adapters/po";
import { chromeJsonAdapter } from "../src/adapters/chrome-json";
import { androidXmlAdapter } from "../src/adapters/android-xml";
import { railsYamlAdapter } from "../src/adapters/rails-yaml";
import { fastlaneMetadataAdapter } from "../src/adapters/fastlane-metadata";
import type { DiscoveredFile, TranslationOutput } from "../src/types";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "agent-translator-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("discovers planned localization targets", async () => {
  await write("App/Localizable.xcstrings", JSON.stringify({ sourceLanguage: "en", version: "1.0", strings: {} }));
  await write("locale/ja/LC_MESSAGES/messages.po", 'msgid ""\nmsgstr ""\n');
  await write("ext/_locales/ja/messages.json", "{}");
  await write("app/src/main/res/values-ja/strings.xml", "<resources></resources>");
  await write("config/locales/ja.yml", "ja: {}\n");
  await write("fastlane/metadata/ja/name.txt", "名前\n");
  const config = await loadConfig(root);
  const files = await discoverFiles(root, config);
  expect(files.map((file) => file.format).sort()).toEqual([
    "android-xml",
    "chrome-json",
    "fastlane-metadata",
    "po",
    "rails-yaml",
    "xcstrings",
  ]);
});

test("extracts and injects xcstrings simple and plural entries", async () => {
  await write(
    "Localizable.xcstrings",
    JSON.stringify({
      sourceLanguage: "en",
      version: "1.0",
      strings: {
        "Stop Recording": {
          comment: "Screen recording button",
          localizations: { en: { stringUnit: { state: "translated", value: "Stop Recording" } } },
        },
        "%lld files": {
          localizations: {
            en: {
              variations: {
                plural: {
                  one: { stringUnit: { state: "translated", value: "%lld file" } },
                  other: { stringUnit: { state: "translated", value: "%lld files" } },
                },
              },
            },
          },
        },
        Brand: { shouldTranslate: false, localizations: { en: { stringUnit: { value: "ScreenKite" } } } },
      },
    })
  );
  const config = { ...(await loadConfig(root)), targetLanguages: ["ja"] };
  const file = discovered("Localizable.xcstrings", "xcstrings", ["ja"]);
  const job = await xcstringsAdapter.extract(file, config, { targetLanguage: "ja", mode: "missing" });
  expect(job.items).toHaveLength(2);
  await xcstringsAdapter.inject(job, output("ja", job.items.map((item) => [item.id, item.key.includes("Stop") ? "録画を停止" : item.source.replace("file", "ファイル")])) as TranslationOutput, config, "translated");
  const written = JSON.parse(await read("Localizable.xcstrings"));
  expect(written.strings["Stop Recording"].localizations.ja.stringUnit.value).toBe("録画を停止");
  expect((await xcstringsAdapter.validate(file, config, "ja")).ok).toBe(true);
});

test("xcstrings extracts target-specific plural categories", async () => {
  await write(
    "Localizable.xcstrings",
    JSON.stringify({
      sourceLanguage: "en",
      version: "1.0",
      strings: {
        "%lld files": {
          localizations: {
            en: {
              variations: {
                plural: {
                  one: { stringUnit: { state: "translated", value: "%lld file" } },
                  other: { stringUnit: { state: "translated", value: "%lld files" } },
                },
              },
            },
          },
        },
      },
    })
  );
  const config = { ...(await loadConfig(root)), targetLanguages: ["ru"] };
  const file = discovered("Localizable.xcstrings", "xcstrings", ["ru"]);
  const job = await xcstringsAdapter.extract(file, config, { targetLanguage: "ru", mode: "missing" });
  expect(job.items.map((item) => item.key).sort()).toEqual(["%lld files/few", "%lld files/many", "%lld files/one", "%lld files/other"]);
});

test("extracts and injects PO entries", async () => {
  await write("ja.po", 'msgid ""\nmsgstr ""\n"Language: ja\\n"\n\n#. Button\nmsgid "Save %@ file"\nmsgstr ""\n');
  const config = await loadConfig(root);
  const file = discovered("ja.po", "po", ["ja"]);
  const job = await poAdapter.extract(file, config, { targetLanguage: "ja", mode: "missing" });
  expect(job.items[0].source).toBe("Save %@ file");
  await poAdapter.inject(job, output("ja", [[job.items[0].id, "%@ファイルを保存"]]), config, "translated");
  expect(await read("ja.po")).toContain('msgstr "%@ファイルを保存"');
});

test("preserves PO plural slots independently", async () => {
  await write("ja.po", 'msgid ""\nmsgstr ""\n"Language: ja\\n"\n\nmsgid "%d file"\nmsgid_plural "%d files"\nmsgstr[0] ""\nmsgstr[1] ""\n');
  const config = await loadConfig(root);
  const file = discovered("ja.po", "po", ["ja"]);
  const job = await poAdapter.extract(file, config, { targetLanguage: "ja", mode: "missing" });
  expect(job.items).toHaveLength(2);
  await poAdapter.inject(
    job,
    output("ja", [
      [job.items[0].id, "%d個のファイル"],
      [job.items[1].id, "%d個のファイル"],
    ]),
    config,
    "translated"
  );
  const written = await read("ja.po");
  expect(written).toContain('msgstr[0] "%d個のファイル"');
  expect(written).toContain('msgstr[1] "%d個のファイル"');
});

test("preserves PO plural slots beyond two forms", async () => {
  await write("ru.po", 'msgid ""\nmsgstr ""\n"Language: ru\\n"\n\nmsgid "%d file"\nmsgid_plural "%d files"\nmsgstr[0] ""\nmsgstr[1] ""\nmsgstr[2] ""\n');
  const config = await loadConfig(root);
  const file = discovered("ru.po", "po", ["ru"]);
  const job = await poAdapter.extract(file, config, { targetLanguage: "ru", mode: "missing" });
  expect(job.items).toHaveLength(3);
  await poAdapter.inject(
    job,
    output("ru", [
      [job.items[0].id, "%d файл"],
      [job.items[1].id, "%d файла"],
      [job.items[2].id, "%d файлов"],
    ]),
    config,
    "translated"
  );
  const written = await read("ru.po");
  expect(written).toContain('msgstr[2] "%d файлов"');
});

test("job creation skips single-language files that do not match requested target", async () => {
  await write("locales/ja/messages.po", 'msgid ""\nmsgstr ""\n"Language: ja\\n"\n\nmsgid "Save"\nmsgstr ""\n');
  const config = await loadConfig(root);
  const files = await discoverFiles(root, config);
  const job = await createJob(files, config, { targetLanguage: "fr", mode: "missing" });
  expect(job.files).toHaveLength(0);
});

test("extracts and injects Chrome locale messages", async () => {
  await write("_locales/en/messages.json", JSON.stringify({ start: { message: "Start capture", description: "Button" } }));
  await write("_locales/ja/messages.json", "{}");
  const config = await loadConfig(root);
  const file = discovered("_locales/ja/messages.json", "chrome-json", ["ja"]);
  const job = await chromeJsonAdapter.extract(file, config, { targetLanguage: "ja", mode: "missing" });
  await chromeJsonAdapter.inject(job, output("ja", [[job.items[0].id, "キャプチャを開始"]]), config, "translated");
  expect(JSON.parse(await read("_locales/ja/messages.json")).start.message).toBe("キャプチャを開始");
});

test("extracts and injects Android XML strings", async () => {
  await write("app/src/main/res/values/strings.xml", '<resources><string name="start">Start %s</string><string name="brand" translatable="false">X</string></resources>');
  await write("app/src/main/res/values-ja/strings.xml", "<resources></resources>");
  const config = await loadConfig(root);
  const file = discovered("app/src/main/res/values-ja/strings.xml", "android-xml", ["ja"]);
  const job = await androidXmlAdapter.extract(file, config, { targetLanguage: "ja", mode: "missing" });
  expect(job.items).toHaveLength(1);
  await androidXmlAdapter.inject(job, output("ja", [[job.items[0].id, "%sを開始"]]), config, "translated");
  expect(await read("app/src/main/res/values-ja/strings.xml")).toContain("%sを開始");
});

test("Android XML extracts target-specific plural categories", async () => {
  await write("app/src/main/res/values/strings.xml", '<resources><plurals name="files"><item quantity="one">%d file</item><item quantity="other">%d files</item></plurals></resources>');
  await write("app/src/main/res/values-ru/strings.xml", "<resources></resources>");
  const config = await loadConfig(root);
  const file = discovered("app/src/main/res/values-ru/strings.xml", "android-xml", ["ru"]);
  const job = await androidXmlAdapter.extract(file, config, { targetLanguage: "ru", mode: "missing" });
  expect(job.items.map((item) => item.key).sort()).toEqual(["files/few", "files/many", "files/one", "files/other"]);
});

test("extracts and injects Rails YAML", async () => {
  await write("config/locales/en.yml", "en:\n  buttons:\n    save: Save %{name}\n");
  await write("config/locales/ja.yml", "ja:\n  buttons: {}\n");
  const config = await loadConfig(root);
  const file = discovered("config/locales/ja.yml", "rails-yaml", ["ja"]);
  const job = await railsYamlAdapter.extract(file, config, { targetLanguage: "ja", mode: "missing" });
  await railsYamlAdapter.inject(job, output("ja", [[job.items[0].id, "%{name}を保存"]]), config, "translated");
  expect(await read("config/locales/ja.yml")).toContain("%{name}を保存");
});

test("extracts and injects Fastlane metadata", async () => {
  await write("fastlane/metadata/en/name.txt", "ScreenKite\n");
  await write("fastlane/metadata/ja/.keep", "");
  const config = await loadConfig(root);
  const file = discovered("fastlane/metadata/ja", "fastlane-metadata", ["ja"]);
  const job = await fastlaneMetadataAdapter.extract(file, config, { targetLanguage: "ja", mode: "missing" });
  await fastlaneMetadataAdapter.inject(job, output("ja", [[job.items[0].id, "ScreenKite"]]), config, "needs_review");
  expect(await read("fastlane/metadata/ja/name.txt")).toBe("ScreenKite\n");
});

test("CLI discover routes through the built command surface", async () => {
  await write("Localizable.xcstrings", JSON.stringify({ sourceLanguage: "en", version: "1.0", strings: {} }));
  const repo = path.resolve(import.meta.dir, "..");
  const result = await Bun.$`bun run ${path.join(repo, "src/cli.ts")} discover ${root} --json`.text();
  expect(JSON.parse(result)[0].format).toBe("xcstrings");
});

function discovered(filePath: string, format: DiscoveredFile["format"], targets: string[]): DiscoveredFile {
  return { path: filePath, format, targetLanguages: targets, sourceLanguage: "en", confidence: "high", warnings: [] };
}

function output(targetLanguage: string, values: Array<[string, string]>): TranslationOutput {
  return {
    schemaVersion: 1,
    targetLanguage,
    translations: values.map(([id, translation]) => ({ id, translation })),
  };
}

async function write(rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content, "utf8");
}

async function read(rel: string): Promise<string> {
  return readFile(path.join(root, rel), "utf8");
}
