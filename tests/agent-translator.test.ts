import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJob, discoverFiles } from "../src/job";
import { loadConfig } from "../src/utils/config";
import { shouldExtract } from "../src/adapters/common";
import { xcstringsAdapter } from "../src/adapters/xcstrings";
import { poAdapter } from "../src/adapters/po";
import { chromeJsonAdapter } from "../src/adapters/chrome-json";
import { androidXmlAdapter } from "../src/adapters/android-xml";
import { railsYamlAdapter } from "../src/adapters/rails-yaml";
import { fastlaneMetadataAdapter } from "../src/adapters/fastlane-metadata";
import { comparePlaceholders, extractPlaceholders } from "../src/utils/placeholders";
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
  await write("locale/en/LC_MESSAGES/messages.po", 'msgid ""\nmsgstr ""\n');
  await write("locale/ja/LC_MESSAGES/messages.po", 'msgid ""\nmsgstr ""\n');
  await write("ext/_locales/en/messages.json", "{}");
  await write("ext/_locales/ja/messages.json", "{}");
  await write("app/src/main/res/values/strings.xml", "<resources></resources>");
  await write("app/src/main/res/values-ja/strings.xml", "<resources></resources>");
  await write("config/locales/en.yml", "en: {}\n");
  await write("config/locales/ja.yml", "ja: {}\n");
  await write("fastlane/metadata/en/name.txt", "Name\n");
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
  expect(files.some((file) => file.path.includes("/en/") || file.path.endsWith("en.yml"))).toBe(false);
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
  const raw = await read("Localizable.xcstrings");
  expect(raw).toContain('"sourceLanguage": "en"');
  expect(raw).not.toContain('"sourceLanguage" : "en"');
  const written = JSON.parse(raw);
  expect(written.strings["Stop Recording"].localizations.ja.stringUnit.value).toBe("録画を停止");
  expect((await xcstringsAdapter.validate(file, config, "ja")).ok).toBe(true);
});

test("xcstrings preserves existing spaced-colon style when present", async () => {
  await write(
    "Localizable.xcstrings",
    '{\n  "sourceLanguage" : "en",\n  "version" : "1.0",\n  "strings" : {\n    "Save" : {\n      "localizations" : {\n        "en" : {\n          "stringUnit" : {\n            "state" : "translated",\n            "value" : "Save"\n          }\n        }\n      }\n    }\n  }\n}\n'
  );
  const config = { ...(await loadConfig(root)), targetLanguages: ["ja"] };
  const file = discovered("Localizable.xcstrings", "xcstrings", ["ja"]);
  const job = await xcstringsAdapter.extract(file, config, { targetLanguage: "ja", mode: "missing" });
  await xcstringsAdapter.inject(job, output("ja", [[job.items[0].id, "保存"]]), config, "translated");
  expect(await read("Localizable.xcstrings")).toContain('"sourceLanguage" : "en"');
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

test("PO extracts only missing plural slots and validates plural placeholders", async () => {
  await write("ru.po", 'msgid ""\nmsgstr ""\n"Language: ru\\n"\n\nmsgid "%d file"\nmsgid_plural "%d files"\nmsgstr[0] "%d файл"\nmsgstr[1] ""\nmsgstr[2] "%s файлов"\n');
  const config = await loadConfig(root);
  const file = discovered("ru.po", "po", ["ru"]);
  const job = await poAdapter.extract(file, config, { targetLanguage: "ru", mode: "missing" });
  expect(job.items.map((item) => item.key)).toEqual([JSON.stringify({ msgctxt: "", msgid: "%d file", idx: 1 })]);
  const validation = await poAdapter.validate(file, config);
  expect(validation.ok).toBe(false);
  expect(validation.errors[0]).toContain("idx");
});

test("PO applies needs_review and translated state to fuzzy flags", async () => {
  await write("ja.po", 'msgid ""\nmsgstr ""\n"Language: ja\\n"\n\nmsgid "Save"\nmsgstr ""\n');
  const config = await loadConfig(root);
  const file = discovered("ja.po", "po", ["ja"]);
  const job = await poAdapter.extract(file, config, { targetLanguage: "ja", mode: "missing" });
  await poAdapter.inject(job, output("ja", [[job.items[0].id, "保存"]]), config, "needs_review");
  expect(await read("ja.po")).toContain("#, fuzzy");
  await poAdapter.inject(job, output("ja", [[job.items[0].id, "保存"]]), config, "translated");
  expect(await read("ja.po")).not.toContain("#, fuzzy");
});

test("PO extract and inject create a missing target from source", async () => {
  await write("locale/en/LC_MESSAGES/messages.po", 'msgid ""\nmsgstr ""\n"Language: en\\n"\n\nmsgid "Save %@ file"\nmsgstr "Save %@ file"\n');
  const config = await loadConfig(root);
  const file = discovered("locale/fr/LC_MESSAGES/messages.po", "po", ["fr"]);
  const audit = await poAdapter.audit(file, config);
  expect(audit.byLanguage.fr.missing).toBe(1);
  const job = await poAdapter.extract(file, config, { targetLanguage: "fr", mode: "missing" });
  expect(job.items).toHaveLength(1);
  expect(job.items[0].existingTarget).toBeNull();
  await poAdapter.inject(job, output("fr", [[job.items[0].id, "Enregistrer le fichier %@"]]), config, "translated");
  const written = await read("locale/fr/LC_MESSAGES/messages.po");
  expect(written).toContain('"Language: fr\\n"');
  expect(written).toContain('msgstr "Enregistrer le fichier %@"');
});

test("PO seeding strips source fuzzy flags", async () => {
  await write("locale/en/LC_MESSAGES/messages.po", 'msgid ""\nmsgstr ""\n"Language: en\\n"\n\n#, fuzzy\nmsgid "Save"\nmsgstr "Save"\n');
  const config = await loadConfig(root);
  const file = discovered("locale/fr/LC_MESSAGES/messages.po", "po", ["fr"]);
  const job = await poAdapter.extract(file, config, { targetLanguage: "fr", mode: "missing" });
  await poAdapter.inject(job, output("fr", [[job.items[0].id, "Enregistrer"]]), config, "translated");
  expect(await read("locale/fr/LC_MESSAGES/messages.po")).not.toContain("#, fuzzy");
});

test("PO extracts missing target from pot template", async () => {
  await write("locale/messages.pot", 'msgid ""\nmsgstr ""\n\nmsgid "Export %@ files"\nmsgstr ""\n');
  const config = await loadConfig(root);
  const files = await discoverFiles(root, { ...config, targetLanguages: ["fr"] });
  const file = files.find((candidate) => candidate.format === "po" && candidate.path === "locale/fr/messages.po");
  expect(file).toBeDefined();
  const job = await poAdapter.extract(file!, config, { targetLanguage: "fr", mode: "missing" });
  expect(job.items[0].source).toBe("Export %@ files");
});

test("PO seeding uses target plural category count", async () => {
  await write("locale/en/LC_MESSAGES/messages.po", 'msgid ""\nmsgstr ""\n"Language: en\\n"\n\nmsgid "%d file"\nmsgid_plural "%d files"\nmsgstr[0] "%d file"\nmsgstr[1] "%d files"\n');
  const config = await loadConfig(root);
  const file = discovered("locale/ru/LC_MESSAGES/messages.po", "po", ["ru"]);
  const job = await poAdapter.extract(file, config, { targetLanguage: "ru", mode: "missing" });
  expect(job.items).toHaveLength(4);
});

test("job creation skips single-language files that do not match requested target", async () => {
  await write("locales/ja/messages.po", 'msgid ""\nmsgstr ""\n"Language: ja\\n"\n\nmsgid "Save"\nmsgstr ""\n');
  const config = await loadConfig(root);
  const files = await discoverFiles(root, config);
  const job = await createJob(files, config, { targetLanguage: "fr", mode: "missing" });
  expect(job.files).toHaveLength(0);
});

test("does not create jobs for source-language files in file-per-language formats", async () => {
  await write("locales/en/messages.po", 'msgid ""\nmsgstr ""\n"Language: en\\n"\n\nmsgid "Save"\nmsgstr ""\n');
  await write("_locales/en/messages.json", JSON.stringify({ save: { message: "Save" } }));
  await write("app/src/main/res/values/strings.xml", '<resources><string name="save">Save</string></resources>');
  await write("config/locales/en.yml", "en:\n  save: Save\n");
  await write("fastlane/metadata/en/name.txt", "ScreenKite\n");
  const config = await loadConfig(root);
  const files = await discoverFiles(root, config);
  expect(files.filter((file) => file.format !== "xcstrings")).toHaveLength(0);
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

test("inject creates a missing Chrome target file", async () => {
  await write("_locales/en/messages.json", JSON.stringify({ start: { message: "Start $name$", description: "Button", placeholders: { name: { content: "$1" } } } }));
  const config = await loadConfig(root);
  const file = discovered("_locales/fr/messages.json", "chrome-json", ["fr"]);
  const job = await chromeJsonAdapter.extract(file, config, { targetLanguage: "fr", mode: "missing" });
  await chromeJsonAdapter.inject(job, output("fr", [[job.items[0].id, "Démarrer $name$"]]), config, "translated");
  const written = JSON.parse(await read("_locales/fr/messages.json"));
  expect(written.start.message).toBe("Démarrer $name$");
  expect(written.start.description).toBe("Button");
  expect(written.start.placeholders.name.content).toBe("$1");
});

test("extracts and injects Android XML strings", async () => {
  await write("app/src/main/res/values/strings.xml", '<resources><string name="start">Start %s</string><string name="brand" translatable="false">X</string></resources>');
  await write("app/src/main/res/values-ja/strings.xml", '<resources xmlns:tools="http://schemas.android.com/tools">\n    <!-- keep -->\n    <string name="brand" translatable="false">X</string>\n</resources>\n');
  const config = await loadConfig(root);
  const file = discovered("app/src/main/res/values-ja/strings.xml", "android-xml", ["ja"]);
  const job = await androidXmlAdapter.extract(file, config, { targetLanguage: "ja", mode: "missing" });
  expect(job.items).toHaveLength(1);
  await androidXmlAdapter.inject(job, output("ja", [[job.items[0].id, "%sを開始"]]), config, "translated");
  const written = await read("app/src/main/res/values-ja/strings.xml");
  expect(written).toContain("%sを開始");
  expect(written).toContain("translatable=\"false\"");
  expect(written).toContain("xmlns:tools");
  expect(written).toContain("<!-- keep -->");
});

test("Android XML extracts target-specific plural categories", async () => {
  await write("app/src/main/res/values/strings.xml", '<resources><plurals name="files"><item quantity="one">%d file</item><item quantity="other">%d files</item></plurals></resources>');
  await write("app/src/main/res/values-ru/strings.xml", "<resources></resources>");
  const config = await loadConfig(root);
  const file = discovered("app/src/main/res/values-ru/strings.xml", "android-xml", ["ru"]);
  const job = await androidXmlAdapter.extract(file, config, { targetLanguage: "ru", mode: "missing" });
  expect(job.items.map((item) => item.key).sort()).toEqual(["files/few", "files/many", "files/one", "files/other"]);
});

test("Android XML audits a missing target file", async () => {
  await write("app/src/main/res/values/strings.xml", '<resources><string name="start">Start</string></resources>');
  const config = await loadConfig(root);
  const file = discovered("app/src/main/res/values-fr/strings.xml", "android-xml", ["fr"]);
  const audit = await androidXmlAdapter.audit(file, config);
  expect(audit.byLanguage.fr.missing).toBe(1);
});

test("Android XML patching preserves CDATA and self-closing resources", async () => {
  await write("app/src/main/res/values/strings.xml", '<resources><string name="html"><![CDATA[<b>Start</b>]]></string><string name="done">Done</string></resources>');
  await write("app/src/main/res/values-ja/strings.xml", '<resources><string name="html"><![CDATA[]]></string></resources>');
  const config = await loadConfig(root);
  const htmlFile = discovered("app/src/main/res/values-ja/strings.xml", "android-xml", ["ja"]);
  const htmlJob = await androidXmlAdapter.extract(htmlFile, config, { targetLanguage: "ja", mode: "missing" });
  await androidXmlAdapter.inject(htmlJob, output("ja", [[htmlJob.items[0].id, "<b>開始</b>"]]), config, "translated");
  expect(await read("app/src/main/res/values-ja/strings.xml")).toContain("<![CDATA[<b>開始</b>]]>");

  await write("app/src/main/res/values-fr/strings.xml", "<resources/>");
  const emptyFile = discovered("app/src/main/res/values-fr/strings.xml", "android-xml", ["fr"]);
  const emptyJob = await androidXmlAdapter.extract(emptyFile, config, { targetLanguage: "fr", mode: "missing" });
  await androidXmlAdapter.inject(emptyJob, output("fr", [[emptyJob.items.find((item) => item.key === "done")!.id, "Terminé $1.99"]]), config, "translated");
  const written = await read("app/src/main/res/values-fr/strings.xml");
  expect(written).toContain("<resources>");
  expect(written).toContain("</resources>");
  expect(written).toContain("Terminé $1.99");
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

test("inject creates a missing Rails YAML target file", async () => {
  await write("config/locales/en.yml", "en:\n  buttons:\n    save: Save %{name}\n");
  const config = await loadConfig(root);
  const file = discovered("config/locales/fr.yml", "rails-yaml", ["fr"]);
  const job = await railsYamlAdapter.extract(file, config, { targetLanguage: "fr", mode: "missing" });
  await railsYamlAdapter.inject(job, output("fr", [[job.items[0].id, "Enregistrer %{name}"]]), config, "translated");
  expect(await read("config/locales/fr.yml")).toContain("Enregistrer %{name}");
});

test("Rails YAML inject preserves existing comments", async () => {
  await write("config/locales/en.yml", "en:\n  buttons:\n    save: Save\n");
  await write("config/locales/ja.yml", "# keep\nja:\n  buttons: {}\n");
  const config = await loadConfig(root);
  const file = discovered("config/locales/ja.yml", "rails-yaml", ["ja"]);
  const job = await railsYamlAdapter.extract(file, config, { targetLanguage: "ja", mode: "missing" });
  await railsYamlAdapter.inject(job, output("ja", [[job.items[0].id, "保存"]]), config, "translated");
  expect(await read("config/locales/ja.yml")).toContain("# keep");
});

test("Rails YAML supports scoped locale filenames", async () => {
  await write("config/locales/devise.en.yml", "en:\n  devise:\n    failure: Failed %{name}\n");
  await write("config/locales/devise.ja.yml", "ja:\n  devise: {}\n");
  const config = await loadConfig(root);
  const files = await discoverFiles(root, { ...config, targetLanguages: ["fr"] });
  expect(files.some((file) => file.path.endsWith("devise.en.yml"))).toBe(false);
  expect(files.some((file) => file.path.endsWith("devise.ja.yml") && file.targetLanguages[0] === "ja")).toBe(true);
  expect(files.some((file) => file.path.endsWith("devise.fr.yml") && file.targetLanguages[0] === "fr")).toBe(true);
  const file = discovered("config/locales/devise.ja.yml", "rails-yaml", ["ja"]);
  const job = await railsYamlAdapter.extract(file, config, { targetLanguage: "ja", mode: "missing" });
  expect(job.items[0].source).toBe("Failed %{name}");
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

test("Fastlane metadata treats en-US as default English source", async () => {
  await write("fastlane/metadata/en-US/name.txt", "ScreenKite\n");
  await write("fastlane/metadata/en-US/changelogs/1.txt", "Bug fixes\n");
  const config = await loadConfig(root);
  const files = await discoverFiles(root, { ...config, targetLanguages: ["fr"] });
  expect(files.some((file) => file.path.endsWith("en-US"))).toBe(false);
  expect(files.some((file) => file.path.endsWith("changelogs"))).toBe(false);
  const file = files.find((candidate) => candidate.format === "fastlane-metadata" && candidate.targetLanguages.includes("fr"));
  expect(file?.path).toBe("fastlane/metadata/fr");
  const job = await fastlaneMetadataAdapter.extract(file!, config, { targetLanguage: "fr", mode: "missing" });
  expect(job.items.map((item) => item.key).sort()).toEqual(["changelogs/1.txt", "name.txt"]);
});

test("Fastlane metadata validates placeholders against source files", async () => {
  await write("fastlane/metadata/en/description.txt", "Export %@ files\n");
  await write("fastlane/metadata/ja/description.txt", "ファイルを書き出し\n");
  const config = await loadConfig(root);
  const file = discovered("fastlane/metadata/ja", "fastlane-metadata", ["ja"]);
  const validation = await fastlaneMetadataAdapter.validate(file, config);
  expect(validation.ok).toBe(false);
  expect(validation.errors[0]).toContain("missing placeholders");
});

test("placeholder validation counts duplicate placeholders", () => {
  const problems = comparePlaceholders(extractPlaceholders("%@ and %@"), "%@だけ");
  expect(problems).toEqual(["missing placeholders: %@"]);
});

test("review mode excludes missing items", () => {
  expect(shouldExtract("missing", { targetLanguage: "ja", mode: "review" })).toBe(false);
  expect(shouldExtract("needs_review", { targetLanguage: "ja", mode: "review" })).toBe(true);
  expect(shouldExtract("translated", { targetLanguage: "ja", mode: "review" })).toBe(true);
});

test("xcstrings inject clears stale extraction state after target is complete", async () => {
  await write(
    "Localizable.xcstrings",
    JSON.stringify({
      sourceLanguage: "en",
      version: "1.0",
      strings: {
        Save: {
          extractionState: "stale",
          localizations: { en: { stringUnit: { state: "translated", value: "Save" } } },
        },
      },
    })
  );
  const config = { ...(await loadConfig(root)), targetLanguages: ["ja"] };
  const file = discovered("Localizable.xcstrings", "xcstrings", ["ja"]);
  const job = await xcstringsAdapter.extract(file, config, { targetLanguage: "ja", mode: "missing" });
  await xcstringsAdapter.inject(job, output("ja", [[job.items[0].id, "保存"]]), config, "translated");
  expect(JSON.parse(await read("Localizable.xcstrings")).strings.Save.extractionState).toBeUndefined();
});

test("xcstrings inject preserves existing localization metadata", async () => {
  await write(
    "Localizable.xcstrings",
    JSON.stringify({
      sourceLanguage: "en",
      version: "1.0",
      strings: {
        Save: {
          localizations: {
            en: { stringUnit: { state: "translated", value: "Save" } },
            ja: { stringUnit: { state: "needs_review", value: "" }, substitutions: { app: { argNum: 1 } } },
          },
        },
      },
    })
  );
  const config = { ...(await loadConfig(root)), targetLanguages: ["ja"] };
  const file = discovered("Localizable.xcstrings", "xcstrings", ["ja"]);
  const job = await xcstringsAdapter.extract(file, config, { targetLanguage: "ja", mode: "missing" });
  await xcstringsAdapter.inject(job, output("ja", [[job.items[0].id, "保存"]]), config, "translated");
  const written = JSON.parse(await read("Localizable.xcstrings"));
  expect(written.strings.Save.localizations.ja.substitutions.app.argNum).toBe(1);
});

test("CLI discover routes through the built command surface", async () => {
  await write("Localizable.xcstrings", JSON.stringify({ sourceLanguage: "en", version: "1.0", strings: {} }));
  const repo = path.resolve(import.meta.dir, "..");
  const result = await Bun.$`bun run ${path.join(repo, "src/cli.ts")} discover ${root} --json`.text();
  expect(JSON.parse(result)[0].format).toBe("xcstrings");
});

test("CLI extract infers missing target files from source locales", async () => {
  await write("locale/en/LC_MESSAGES/messages.po", 'msgid ""\nmsgstr ""\n"Language: en\\n"\n\nmsgid "Save"\nmsgstr "Save"\n');
  await write("_locales/en/messages.json", JSON.stringify({ start: { message: "Start" } }));
  await write("app/src/main/res/values/strings.xml", '<resources><string name="done">Done</string></resources>');
  await write("config/locales/en.yml", "en:\n  done: Done\n");
  await write("fastlane/metadata/en/name.txt", "ScreenKite\n");
  const repo = path.resolve(import.meta.dir, "..");
  const out = path.join(root, ".agent-translator/jobs/fr");
  await Bun.$`bun run ${path.join(repo, "src/cli.ts")} extract ${root} --target fr --out ${out}`.quiet();
  const job = JSON.parse(await read(".agent-translator/jobs/fr/job.json")) as { files: Array<{ format: string; path: string }> };
  expect(job.files.map((file) => file.format).sort()).toEqual(["android-xml", "chrome-json", "fastlane-metadata", "po", "rails-yaml"]);
  expect(job.files.some((file) => file.path.includes("/fr/") || file.path.endsWith("fr.yml") || file.path.includes("values-fr"))).toBe(true);
});

test("CLI help includes coding-agent quickstart", async () => {
  const repo = path.resolve(import.meta.dir, "..");
  const result = await Bun.$`bun run ${path.join(repo, "src/cli.ts")} --help`.text();
  expect(result).toContain("Guide for Codex / Claude Code / Antigravity");
  expect(result).toContain("agent-translator discover .");
  expect(result).toContain("agent-translator init");
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
