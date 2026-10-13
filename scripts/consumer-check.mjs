#!/usr/bin/env node
// Checks the packed workspaces the way a consumer uses them: the tarballs are
// installed into a fresh project, which is type checked (with `@types/node` 24
// and 26) and then run as ESM against a real server. The TypeScript examples of
// the READMEs are type checked against the same installation.
//
// `@types/node` 26 is checked with `skipLibCheck`: the types of `thread-stream`
// (pulled in by `pino`, used by `@binden/logger`) still refer to
// `worker_threads.TransferListItem`, which `@types/node` 26 removed.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { npm } from "./npm.mjs";
import { tmpdir } from "node:os";

const root = join(import.meta.dirname, "..");
const readJSON = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const { devDependencies, workspaces } = readJSON("package.json");
// Packages that the examples import besides the workspaces
const exampleDependencies = {
  ajv: readJSON("packages/body/package.json").devDependencies.ajv,
  "fast-json-stringify": readJSON("packages/binden/package.json")
    .devDependencies["fast-json-stringify"],
};

const consumer = `import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Binden, BindenError, type Context, Router } from "binden";
import log, { Logger } from "@binden/logger";
import bodyParser, { BodyParser } from "@binden/body";
import compression, { Compression } from "@binden/compression";
import multipart, { Multipart } from "@binden/multipart";

const logger = new Logger({ level: "silent" }).child({ consumer: true });
logger.info("consumer check");
log.debug("default logger");

const parse = (input: string): { message: string } =>
  JSON.parse(input) as { message: string };

const app = new Binden()
  .use(new Compression({ format: "auto" }))
  .use(
    "/json",
    new Router().post(new BodyParser({ parse }), (context: Context) =>
      context.json({ received: context.request.body as Record<string, unknown> }),
    ),
  )
  .use(
    "/form",
    new Router().post(
      new Multipart({ config: { limits: { fields: 4 } } }),
      (context: Context) =>
        context.text(String((context.request.body as FormData).get("field"))),
    ),
  )
  .use("/error", () => {
    throw new BindenError(400, { expose: true, message: "consumer error" });
  });

if (![bodyParser, compression].every(Boolean) || typeof multipart !== "function") {
  throw new Error("Missing default exports");
}

const server = app.createServer().listen(0);
await once(server, "listening");
const { port } = server.address() as AddressInfo;
const url = \`http://localhost:\${port}\`;

try {
  const json = await fetch(\`\${url}/json\`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });
  const { received } = (await json.json()) as { received: { message: string } };
  if (received.message !== "hello") {
    throw new Error("Unexpected JSON response");
  }

  const form = new FormData();
  form.append("field", "value");
  const text = await (await fetch(\`\${url}/form\`, { method: "POST", body: form })).text();
  if (text !== "value") {
    throw new Error("Unexpected FormData response");
  }

  const error = await fetch(\`\${url}/error\`);
  if (error.status !== 400 || (await error.text()) !== "consumer error") {
    throw new Error("Unexpected error response");
  }
} finally {
  server.close();
}
`;

// The placeholders that the examples use without declaring them
const globals = `import type { Binden, BindenRequest, BindenResponse, Context, IMiddleware, Router } from "binden";

declare global {
  const app: Binden;
  const context: Context;
  const request: BindenRequest;
  const response: BindenResponse<BindenRequest>;
  const middleware: IMiddleware;
  const middleware1: IMiddleware;
  const middleware2: IMiddleware;
  const router: Router;
  const router2: Router;
  const router3: Router;
  const key: string;
  const cert: string;
  function validateBody(): Promise<void>;
}
`;

const dir = mkdtempSync(join(tmpdir(), "binden-consumer-"));

/** Writes every `typescript` block of the READMEs as a module of `examples/` */
function writeExamples() {
  const examples = join(dir, "examples");
  mkdirSync(examples);
  let count = 0;
  for (const workspace of workspaces) {
    const readme = readFileSync(join(root, workspace, "README.md"), "utf8");
    const name = workspace.split("/").at(-1);
    const blocks = readme.matchAll(
      /^```typescript\r?\n(?<code>[\s\S]*?)^```\r?$/gmu,
    );
    for (const [index, { groups }] of [...blocks].entries()) {
      writeFileSync(join(examples, `${name}-${index + 1}.ts`), groups.code);
      count += 1;
    }
  }
  if (count === 0) {
    throw new Error("No TypeScript examples found in the READMEs");
  }
  writeFileSync(join(examples, "globals.d.ts"), globals);
  process.stderr.write(`[consumer] ${count} README examples\n`);
  return examples;
}

function run(command, args, cwd = dir) {
  process.stderr.write(`[consumer] ${command} ${args.join(" ")}\n`);
  const options = { cwd, stdio: ["ignore", "inherit", "inherit"] };
  if (command === "npm") {
    npm(args, options);
  } else {
    execFileSync(command, args, options);
  }
}

try {
  run(
    "npm",
    ["pack", "--workspaces", "--pack-destination", dir, "--loglevel=warn"],
    root,
  );
  const tarballs = readdirSync(dir)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => join(dir, file));

  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ private: true, type: "module" })}\n`,
  );
  writeFileSync(join(dir, "consumer.ts"), consumer);
  const examples = writeExamples();

  for (const [types, skipLibCheck] of [
    ["24", false],
    ["26", true],
  ]) {
    run("npm", [
      "install",
      // Every package gets its own node_modules: an import of a dependency that
      // is not declared (but hoisted in this repository) fails
      "--install-strategy=nested",
      "--no-audit",
      "--no-fund",
      "--loglevel=warn",
      ...tarballs,
      `typescript@${devDependencies.typescript}`,
      `@types/node@${types}`,
      ...Object.entries(exampleDependencies).map(
        ([name, version]) => `${name}@${version}`,
      ),
    ]);
    writeFileSync(
      join(dir, "tsconfig.json"),
      `${JSON.stringify({
        compilerOptions: {
          module: "nodenext",
          target: "es2022",
          strict: true,
          skipLibCheck,
          types: ["node"],
          outDir: "dist",
        },
        files: ["consumer.ts"],
      })}\n`,
    );
    run(process.execPath, [
      join(dir, "node_modules/typescript/bin/tsc"),
      "-p",
      dir,
    ]);
    run(process.execPath, [join(dir, "dist/consumer.js")]);

    // Each example is a module (`moduleDetection`), checked as strictly as the consumer
    writeFileSync(
      join(examples, "tsconfig.json"),
      `${JSON.stringify({
        compilerOptions: {
          module: "nodenext",
          target: "es2022",
          strict: true,
          moduleDetection: "force",
          noEmit: true,
          skipLibCheck,
          types: ["node"],
        },
        include: ["*.ts"],
      })}\n`,
    );
    run(process.execPath, [
      join(dir, "node_modules/typescript/bin/tsc"),
      "-p",
      examples,
    ]);
  }
  process.stderr.write("[consumer] OK\n");
} finally {
  rmSync(dir, { force: true, recursive: true });
}
