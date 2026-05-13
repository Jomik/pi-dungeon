import { type Static, Type } from "typebox";

const SecretConfigSchema = Type.Object({
  keychain: Type.String(),
  hosts: Type.Array(Type.String()),
});

export const DungeonConfigSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    allowedHosts: Type.Optional(Type.Array(Type.String())),
    secrets: Type.Optional(Type.Record(Type.String(), SecretConfigSchema)),
    mounts: Type.Optional(Type.Array(Type.String())),
    hiddenPaths: Type.Optional(Type.Array(Type.String())),
    tmpfsPaths: Type.Optional(Type.Array(Type.String())),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    resources: Type.Optional(
      Type.Object({
        memory: Type.Optional(Type.String()),
        cpus: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
    ),
  },
  { additionalProperties: false },
);

export type DungeonConfig = Static<typeof DungeonConfigSchema>;
export type SecretConfig = Static<typeof SecretConfigSchema>;

export interface PathMapping {
  hostDir: string;
  guestDir: string;
}
