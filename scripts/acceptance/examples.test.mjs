// Runs the examples (`examples/*.ts`) from their sources against the workspaces
// (built), with tsx: see `scripts/examples.mjs` for what each one must do.
import { describe, it } from "node:test";
import { examples, runExample } from "../examples.mjs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

describe("examples", () => {
  for (const example of examples) {
    it(
      example.name,
      { skip: process.platform === "win32" && "SIGTERM kills on Windows" },
      () =>
        runExample(example, {
          command: process.execPath,
          args: [
            "--import",
            "tsx",
            join(root, "examples", `${example.file}.ts`),
          ],
          cwd: root,
        }),
    );
  }
});
