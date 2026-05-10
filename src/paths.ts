import os from "node:os";
import path from "node:path";

import type { PathMapping } from "./types.ts";

export const GUEST_PI_AGENT = "/root/.pi/agent";
export const GUEST_GITHUB_REPOS = "/tmp/pi-github-repos";

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function createPathMappings(localCwd: string, guestWorkspace: string): PathMapping[] {
  const home = os.homedir();
  return [
    { hostDir: localCwd, guestDir: guestWorkspace },
    { hostDir: path.join(home, ".pi/agent"), guestDir: GUEST_PI_AGENT },
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
