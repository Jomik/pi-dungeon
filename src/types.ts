export interface SecretConfig {
  keychain: string; // keychain account name
  hosts: string[]; // hosts that receive this secret
}

export interface DungeonConfig {
  allowedHosts?: string[];
  secrets?: Record<string, SecretConfig>;
  mounts?: Record<string, { path: string; mode?: "ro" | "rw" }>;
}

export interface PathMapping {
  hostDir: string;
  guestDir: string;
}
