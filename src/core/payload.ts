/**
 * Brief builder. Claude/ChatGPT get a short brief, never a repo dump.
 * Absolute unix/windows paths, home-src, Android Studio projects, and .git must not appear.
 */
import type { Owner } from "./types.ts";
import { SendRejectedError } from "./types.ts";

export const REPO_DUMP_RE =
  /(?:\/Users\/|\/home\/|\/root\/|~\/src\b|AndroidStudioProjects|\.git\b|[A-Za-z]:\\|[A-Za-z]:\/)/i;

const MAX_BRIEF_CHARS = 720;

export function stripRepoPaths(text: string): string {
  return text
    .replace(/\/Users\/[^\s]+/gi, "[redacted-path]")
    .replace(/\/home\/[^\s]+/gi, "[redacted-path]")
    .replace(/\/root\/[^\s]+/gi, "[redacted-path]")
    .replace(/~\/src[^\s]*/gi, "[redacted-path]")
    .replace(/[A-Za-z]:\\[^\s]*/g, "[redacted-path]")
    .replace(/[A-Za-z]:\/[^\s]*/g, "[redacted-path]")
    .replace(/AndroidStudioProjects[^\s]*/gi, "[redacted-project]")
    .replace(/(?:^|[\s])(?:\/[^\s]*)?\.git(?:\/[^\s]*)?/gi, " [redacted-git]");
}

export function buildBrief(owner: Owner, prompt: string): string {
  const cleaned = stripRepoPaths(prompt).replace(/\s+/g, " ").trim();
  if (owner === "claude" || owner === "chatgpt") {
    const clipped = cleaned.slice(0, MAX_BRIEF_CHARS);
    return `Brief (no repo dump):\n${clipped}`;
  }
  if (owner === "cursor") {
    return cleaned.slice(0, 4000);
  }
  return cleaned.slice(0, 2000);
}

export function assertNoRepoDump(owner: Owner, payload: string): void {
  if (owner === "claude" || owner === "chatgpt") {
    if (REPO_DUMP_RE.test(payload)) {
      throw new SendRejectedError(
        "repo_dump",
        `${owner} payload must not contain a repo path`,
      );
    }
  }
}

export function payloadContainsRepoPath(payload: string): boolean {
  return REPO_DUMP_RE.test(payload);
}
