export interface ParsedFile {
  path: string;
  language: string;
  content: string;
}

export interface ParsedFileDeliverable {
  intro: string;
  files: ParsedFile[];
}

const FILE_BLOCK_RE = /###\s*FILE:\s*(\S+)\s*\r?\n```(\w+)?\r?\n([\s\S]*?)```/g;

/**
 * Mirrors frontend/src/utils/fileDeliverable.ts's parser. Kept as a
 * separate copy rather than a shared package since frontend and backend
 * are independent runtimes in this repo — but the format contract (the
 * "### FILE: path" convention from orchestration.service.ts's
 * APP-BUILDER OUTPUT FORMAT prompt) must stay identical between the two.
 */
export function parseFileDeliverable(markdown: string): ParsedFileDeliverable | null {
  if (!markdown || !/###\s*FILE:/.test(markdown)) return null;

  const files: ParsedFile[] = [];
  const firstMatch = markdown.search(/###\s*FILE:/);
  const intro = firstMatch > 0 ? markdown.slice(0, firstMatch).trim() : "";

  FILE_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_BLOCK_RE.exec(markdown)) !== null) {
    const [, path, , content] = match;
    files.push({ path: path.trim(), language: match[2] || "", content: content.replace(/\n$/, "") });
  }

  if (files.length === 0) return null;
  return { intro, files };
}

export interface StructuralCheckResult {
  passed: boolean;
  issues: string[];
  hasReadme: boolean;
  hasManifest: boolean;
}

const PLACEHOLDER_PATTERNS = [
  /\btodo\b/i,
  /\bfixme\b/i,
  /rest of (the )?code (goes )?here/i,
  /\.\.\.\s*(rest|remaining|etc)/i,
  /<your code here>/i,
  /\[insert .*?here\]/i,
  /implementation (goes|to be added) here/i,
];

const MANIFEST_FILENAMES = /^(package\.json|requirements\.txt|go\.mod|cargo\.toml|composer\.json|gemfile)$/i;

/**
 * Deterministic, non-LLM pre-check run before spending an evaluation call
 * on an app-builder deliverable. Catches obvious structural failures
 * cheaply and consistently — an LLM judge can be inconsistent about
 * whether "// TODO: implement" counts as disqualifying, a regex isn't.
 */
export function runStructuralCheck(parsed: ParsedFileDeliverable): StructuralCheckResult {
  const issues: string[] = [];

  const hasReadme = parsed.files.some((f) => /readme(\.md)?$/i.test(f.path));
  const hasManifest = parsed.files.some((f) => MANIFEST_FILENAMES.test(f.path.split("/").pop() || ""));

  if (!hasReadme) issues.push("No README with setup/run instructions");
  if (!hasManifest) issues.push("No dependency manifest (package.json / requirements.txt / etc.)");

  for (const file of parsed.files) {
    if (file.content.trim().length < 10) {
      issues.push(`${file.path} is empty or near-empty`);
      continue;
    }
    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.test(file.content)) {
        issues.push(`${file.path} contains placeholder/stub content instead of real implementation`);
        break;
      }
    }
  }

  // Structural failure = missing manifest entirely, or any file is a stub.
  // A missing README is a quality ding (fed to the LLM rubric) but not an
  // automatic fail on its own — some tiny scripts genuinely don't need one.
  const hardFailure = !hasManifest || issues.some((i) => i.includes("placeholder") || i.includes("empty"));

  return { passed: !hardFailure, issues, hasReadme, hasManifest };
}
