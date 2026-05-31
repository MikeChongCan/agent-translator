const PATTERNS = [
  /%(?:\d+\$)?(?:[-+#0 ]*)?(?:\d+|\*)?(?:\.(?:\d+|\*))?(?:hh|h|ll|l|z|t|j)?[@diuoxXfFeEgGaAcsp]/g,
  /%\{[A-Za-z_][A-Za-z0-9_]*\}/g,
  /%<[^>]+>[a-zA-Z]/g,
  /\{[A-Za-z_][A-Za-z0-9_]*\}/g,
  /\$[A-Za-z_][A-Za-z0-9_]*\$/g,
];

export function extractPlaceholders(value: string): string[] {
  const found = new Set<string>();
  for (const pattern of PATTERNS) {
    for (const match of value.matchAll(pattern)) {
      found.add(match[0]);
    }
  }
  return [...found].sort();
}

export function comparePlaceholders(source: string[], targetValue: string): string[] {
  const target = extractPlaceholders(targetValue);
  const sourceCounts = counts(source.map(canonicalPlaceholder));
  const targetCounts = counts(target.map(canonicalPlaceholder));
  const missing = diffCounts(sourceCounts, targetCounts);
  const added = diffCounts(targetCounts, sourceCounts);
  const errors: string[] = [];
  if (missing.length > 0) errors.push(`missing placeholders: ${missing.join(", ")}`);
  if (added.length > 0) errors.push(`unexpected placeholders: ${added.join(", ")}`);
  return errors;
}

function canonicalPlaceholder(value: string): string {
  return value.replace(/^%(\d+\$)/, "%");
}

function counts(values: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return map;
}

function diffCounts(left: Map<string, number>, right: Map<string, number>): string[] {
  const result: string[] = [];
  for (const [value, count] of left) {
    const delta = count - (right.get(value) ?? 0);
    for (let i = 0; i < delta; i += 1) result.push(value);
  }
  return result;
}
