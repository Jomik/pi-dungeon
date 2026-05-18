import os from "node:os";
import path from "node:path";

import type { PathMapping } from "./types.ts";

const HOME = os.homedir();
export const GUEST_GITHUB_REPOS = "/tmp/pi-github-repos";

export type PathClass =
  | { kind: "glob"; pattern: string }
  | { kind: "workspace"; relativePath: string }
  | { kind: "external"; absolutePath: string }
  | { kind: "skip" }; // workspace root or unresolvable

/**
 * Expand ~ and resolve a path entry to an absolute path, stripping trailing slashes.
 */
export function resolvePath(entry: string, home: string, localCwd: string): string {
  const expanded = entry.replace(/^~/, home);
  return (expanded.startsWith("/") ? expanded : path.resolve(localCwd, expanded)).replace(/\/+$/, "") || "/";
}

/**
 * Classify a config path entry (cachePath/hiddenPath) relative to the workspace.
 */
export function classifyPath(entry: string, home: string, localCwd: string): PathClass {
  // Expand ~ before classification so glob patterns get a proper absolute prefix
  const expanded = entry.replace(/^~/, home);

  if (expanded.includes("*")) {
    return { kind: "glob", pattern: expanded };
  }
  const absolutePath = resolvePath(entry, home, localCwd);
  if (absolutePath === localCwd) {
    return { kind: "skip" };
  }
  if (absolutePath.startsWith(`${localCwd}/`)) {
    return { kind: "workspace", relativePath: absolutePath.slice(localCwd.length) };
  }
  return { kind: "external", absolutePath };
}

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function createPathMappings(localCwd: string, guestWorkspace: string): PathMapping[] {
  return [
    { hostDir: localCwd, guestDir: guestWorkspace },
    { hostDir: path.join(HOME, ".pi/agent"), guestDir: path.join(HOME, ".pi/agent") },
    { hostDir: "/tmp/pi-github-repos", guestDir: GUEST_GITHUB_REPOS },
  ];
}

export function toGuestPath(mappings: PathMapping[], localPath: string): string {
  for (const { hostDir, guestDir } of mappings) {
    if (localPath === hostDir) return guestDir;
    const rel = path.relative(hostDir, localPath);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      const posixRel = rel.split(path.sep).join(path.posix.sep);
      return path.posix.join(guestDir, posixRel);
    }
  }
  throw new Error(`path not accessible in sandbox: ${localPath}`);
}
