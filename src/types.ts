export interface SecretConfig {
  keychain: string; // keychain account name
  hosts: string[]; // hosts that receive this secret
}

export interface DungeonConfig {
  allowedHosts?: string[];
  secrets?: Record<string, SecretConfig>;
  mounts?: string[];
  hiddenPaths?: string[]; // completely hidden from guest (ENOENT)
  tmpfsPaths?: string[]; // shadowed from host, guest writes to tmpfs cache
  env?: Record<string, string>;
  resources?: {
    memory?: string; // qemu syntax, e.g. "1G", "2G"
    cpus?: number; // e.g. 2, 4
  };
}

export interface PathMapping {
  hostDir: string;
  guestDir: string;
}
