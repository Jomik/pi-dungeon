import fs from "node:fs";
import path from "node:path";
import { DungeonConfigSchema } from "../src/types.ts";

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/Jomik/pi-dungeon/dungeon.schema.json",
  title: "Dungeon Config",
  ...DungeonConfigSchema,
};

const outPath = path.join(import.meta.dirname, "..", "dungeon.schema.json");
fs.writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`Written: ${outPath}`);
