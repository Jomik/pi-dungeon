import os from "node:os";
import path from "node:path";

import type { PathMapping } from "./types.ts";

const HOME = os.homedir();
export const GUEST_GITHUB_REPOS = "/tmp/pi-github-repos";

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
