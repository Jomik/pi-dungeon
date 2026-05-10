export interface SecretConfig {
  keychain: string; // keychain account name
  hosts: string[]; // hosts that receive this secret
}

export interface DungeonConfig {
  allowedHosts?: string[];
  secrets?: Record<string, SecretConfig>;
  mounts?: Record<string, { path: string; mode?: "ro" | "rw" }>;
  hiddenPaths?: string[]; // completely hidden from guest (ENOENT)
  tmpfsPaths?: string[]; // shadowed from host, guest writes to tmpfs cache
}

export interface PathMapping {
  hostDir: string;
  guestDir: string;
}
