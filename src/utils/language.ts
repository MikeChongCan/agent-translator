export function languageFromPathSegment(segment: string): string | null {
  if (segment === "values") return "en";
  if (segment.startsWith("values-b+")) return segment.slice("values-b+".length).replaceAll("+", "-");
  if (segment.startsWith("values-")) return segment.slice("values-".length).replace("-r", "-");
  if (segment.endsWith(".lproj")) return segment.slice(0, -".lproj".length);
  if (/^[a-z]{2,3}([_-][A-Za-z0-9]+)*$/.test(segment)) return segment.replace("_", "-");
  return null;
}

export function androidFolderForLanguage(language: string): string {
  if (language.includes("-")) {
    const [base, regionOrScript] = language.split("-");
    if (regionOrScript && regionOrScript.length === 4) return `values-b+${base}+${regionOrScript}`;
    return `values-${base}-r${regionOrScript}`;
  }
  return `values-${language}`;
}

export function normalizeLocale(value: string): string {
  return value.replace("_", "-");
}
