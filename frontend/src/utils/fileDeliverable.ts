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
 * Parses the app-builder agent's "### FILE: path" + fenced-code-block
 * convention (see orchestration.service.ts's APP-BUILDER OUTPUT FORMAT
 * prompt) into a real list of files. Returns null if the deliverable
 * doesn't use this format (e.g. it's a non-app-builder subtask, or the
 * model didn't follow instructions) so callers can fall back to rendering
 * it as plain markdown.
 */
export function parseFileDeliverable(markdown: string): ParsedFileDeliverable | null {
  if (!markdown || !/###\s*FILE:/.test(markdown)) return null;

  const files: ParsedFile[] = [];
  const firstMatch = markdown.search(/###\s*FILE:/);
  const intro = firstMatch > 0 ? markdown.slice(0, firstMatch).trim() : "";

  FILE_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_BLOCK_RE.exec(markdown)) !== null) {
    const [, path, language, content] = match;
    files.push({
      path: path.trim(),
      language: language || guessLanguage(path),
      content: content.replace(/\n$/, ""),
    });
  }

  if (files.length === 0) return null;
  return { intro, files };
}

function guessLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    php: "php", html: "html", css: "css", json: "json", md: "markdown",
    sql: "sql", sh: "bash", yml: "yaml", yaml: "yaml", env: "bash",
  };
  return map[ext] || "text";
}
