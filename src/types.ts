export type FormatId =
  | "xcstrings"
  | "po"
  | "chrome-json"
  | "android-xml"
  | "rails-yaml"
  | "fastlane-metadata";

export type Confidence = "high" | "medium" | "low";
export type TranslationState = "missing" | "new" | "stale" | "needs_review" | "translated";
export type InjectState = "translated" | "needs_review";

export interface AgentTranslatorConfig {
  app?: {
    name?: string;
    description?: string;
  };
  sourceLanguage?: string;
  targetLanguages?: string[];
  glossary?: Record<string, GlossaryEntry>;
  files?: Array<{
    format: FormatId;
    include: string[];
    exclude?: string[];
  }>;
}

export interface GlossaryEntry {
  description?: string;
  preferred?: Record<string, string>;
  forbidden?: Record<string, string[]>;
  unlessKeyContains?: string[];
}

export interface ResolvedConfig extends AgentTranslatorConfig {
  root: string;
  sourceLanguage: string;
  targetLanguages: string[];
}

export interface DiscoveredFile {
  path: string;
  format: FormatId;
  sourceLanguage?: string;
  targetLanguages: string[];
  confidence: Confidence;
  warnings: string[];
}

export interface AuditResult {
  file: DiscoveredFile;
  total: number;
  translatable: number;
  byLanguage: Record<string, LanguageAudit>;
  warnings: string[];
}

export interface LanguageAudit {
  translated: number;
  missing: number;
  stale: number;
  needsReview: number;
}

export interface TranslationItem {
  id: string;
  file: string;
  format: FormatId;
  key: string;
  source: string;
  targetLanguage: string;
  comment?: string;
  existingTarget?: string | null;
  state: TranslationState;
  placeholders: string[];
  constraints?: {
    preservePlaceholders?: boolean;
    forbiddenTerms?: string[];
    maxLength?: number;
  };
  meta?: Record<string, unknown>;
}

export interface FileJob {
  path: string;
  format: FormatId;
  items: TranslationItem[];
  warnings: string[];
}

export interface TranslationJob {
  schemaVersion: 1;
  createdAt: string;
  root: string;
  sourceLanguage: string;
  targetLanguage: string;
  mode: ExtractOptions["mode"];
  app?: AgentTranslatorConfig["app"];
  files: FileJob[];
  warnings: string[];
}

export interface TranslationOutput {
  schemaVersion: 1;
  targetLanguage: string;
  translations: Array<{
    id: string;
    translation: string;
    notes?: string;
  }>;
}

export interface InjectResult {
  file: string;
  injected: number;
  skipped: number;
  warnings: string[];
}

export interface ValidationResult {
  ok: boolean;
  file?: string;
  errors: string[];
  warnings: string[];
}

export interface ExtractOptions {
  targetLanguage: string;
  mode: "missing" | "stale" | "needs-review" | "all" | "review";
}

export interface Adapter {
  format: FormatId;
  discover(root: string, config: ResolvedConfig): Promise<DiscoveredFile[]>;
  audit(file: DiscoveredFile, config: ResolvedConfig): Promise<AuditResult>;
  extract(file: DiscoveredFile, config: ResolvedConfig, options: ExtractOptions): Promise<FileJob>;
  inject(
    file: FileJob,
    output: TranslationOutput,
    config: ResolvedConfig,
    state: InjectState
  ): Promise<InjectResult>;
  validate(file: DiscoveredFile, config: ResolvedConfig, targetLanguage?: string): Promise<ValidationResult>;
}
