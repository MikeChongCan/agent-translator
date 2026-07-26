import { describe, expect, test } from "bun:test";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { scanSwift } from "../src/scanner";

describe("scanner", () => {
  test("scans Swift files and merges new localized strings into .xcstrings", async () => {
    const tmpDir = path.join(process.cwd(), ".tmp-test-scan-" + Date.now());
    await mkdir(tmpDir, { recursive: true });

    try {
      const swiftContent = `
        import SwiftUI

        struct TestView: View {
          var body: some View {
            VStack {
              Text("Hello, World!")
              Text("Welcome back \(username)")
              let title = String(localized: "Settings")
              let msg = NSLocalizedString("Save changes", comment: "Button label")
            }
          }
        }
      `;
      await writeFile(path.join(tmpDir, "TestView.swift"), swiftContent, "utf8");

      const xcstringsContent = JSON.stringify({
        sourceLanguage: "en",
        version: "1.0",
        strings: {
          "Hello, World!": {
            localizations: {
              de: { stringUnit: { state: "translated", value: "Hallo Welt!" } }
            }
          }
        }
      }, null, 2);
      const catalogPath = path.join(tmpDir, "Localizable.xcstrings");
      await writeFile(catalogPath, xcstringsContent, "utf8");

      const result = await scanSwift(tmpDir, catalogPath);

      expect(result.scannedFiles).toBe(1);
      expect(result.addedKeys).toBe(3); // "Welcome back", "Settings", "Save changes"
      expect(result.keys).toContain("Hello, World!");
      expect(result.keys).toContain("Welcome back %@");
      expect(result.keys).toContain("Settings");

      const updatedCatalog = JSON.parse(await readFile(catalogPath, "utf8"));
      expect(updatedCatalog.strings["Hello, World!"]).toBeDefined();
      expect(updatedCatalog.strings["Welcome back %@"]).toBeDefined();
      expect(updatedCatalog.strings["Settings"]).toBeDefined();
      expect(updatedCatalog.strings["Save changes"]).toBeDefined();
      expect(updatedCatalog.strings["Save changes"].comment).toBe("Button label");

      // Verify existing German translation was preserved
      expect(updatedCatalog.strings["Hello, World!"].localizations.de.stringUnit.value).toBe("Hallo Welt!");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
