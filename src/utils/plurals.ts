export function pluralCategories(language: string): string[] {
  try {
    return new Intl.PluralRules(language).resolvedOptions().pluralCategories;
  } catch {
    return ["one", "other"];
  }
}

export function valueForPluralForm(values: Record<string, string | undefined>, form: string): string {
  return values[form] ?? values.other ?? values.one ?? Object.values(values).find((value): value is string => Boolean(value)) ?? "";
}
