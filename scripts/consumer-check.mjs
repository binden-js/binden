#!/usr/bin/env node
// Checks the packed workspaces the way a consumer uses them:
//
// - every bare import of the modules and declarations of an archive (`dist/`) is
//   declared by its `package.json` (`scripts/imports.mjs`);
// - the tarballs are installed into a fresh project, which is type checked and then
//   run as ESM against a real server. The TypeScript examples of the READMEs and of
//   the guides at the root (`documents`) are type checked against the same
//   installation, and so are the runnable examples (`examples/*.ts`), which are then
//   compiled, run and checked over HTTP (`scripts/examples.mjs`, POSIX only);
// - each tarball is installed alone into a project of its own, with what it declares
//   (its dependencies and peers, from the other tarballs), then type checked and
//   imported (its root and its `package.json`, while its deep paths are closed).
//
// The installation of all the tarballs is checked with:
//
// - the TypeScript of this repository and `@types/node` 24;
// - the same TypeScript and `@types/node` 26, with `skipLibCheck`: the types of
//   `thread-stream` (pulled in by `pino`, used by `@binden/logger`) still refer to
//   `worker_threads.TransferListItem`, which `@types/node` 26 removed;
// - TypeScript 7 (the native compiler, which the tooling of this repository does
//   not support yet) and `@types/node` 24.
//
//   node scripts/consumer-check.mjs                    packs the workspaces itself
//   node scripts/consumer-check.mjs --tarballs <dir>   the archives that
//                                                      `scripts/release.mjs pack <dir>`
//                                                      prepared (their integrity is checked)
import { basename, join, resolve } from "node:path";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { examples, runExample } from "./examples.mjs";
import { readRelease, readTarball } from "./tarballs.mjs";
import { execFileSync } from "node:child_process";
import { npm } from "./npm.mjs";
import { tmpdir } from "node:os";
import { undeclaredImports } from "./imports.mjs";

const root = join(import.meta.dirname, "..");
const readJSON = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const { devDependencies, workspaces } = readJSON("package.json");
// The guides at the root of the repository, whose examples are checked as those of
// the READMEs (each one must exist and have some)
const documents = ["MIGRATION-4.md", "PRODUCTION.md"];
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

const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;
const url = \`http://127.0.0.1:\${port}\`;

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

const blockPattern = /^```typescript\r?\n(?<code>[\s\S]*?)^```\r?$/gmu;

/** The `typescript` blocks of a Markdown file */
const blocksOf = (markdown) =>
  [...markdown.matchAll(blockPattern)].map(({ groups }) => groups.code);

/**
 * Writes every `typescript` block of the READMEs and of the guides at the root
 * (`documents`) as a module of `snippets/`
 */
function writeSnippets() {
  const target = join(dir, "snippets");
  mkdirSync(target);
  let count = 0;
  const write = (name, blocks) => {
    for (const [index, code] of blocks.entries()) {
      writeFileSync(join(target, `${name}-${index + 1}.ts`), code);
      count += 1;
    }
  };
  for (const workspace of workspaces) {
    const readme = readFileSync(join(root, workspace, "README.md"), "utf8");
    write(workspace.split("/").at(-1), blocksOf(readme));
  }
  if (count === 0) {
    throw new Error("No TypeScript examples found in the READMEs");
  }
  for (const document of documents) {
    const path = join(root, document);
    if (!existsSync(path)) {
      throw new Error(
        `${document} is missing: its examples are checked (\`documents\` of scripts/consumer-check.mjs)`,
      );
    }
    const blocks = blocksOf(readFileSync(path, "utf8"));
    if (blocks.length === 0) {
      throw new Error(`No TypeScript examples found in ${document}`);
    }
    write(basename(document, ".md"), blocks);
  }
  writeFileSync(join(target, "globals.d.ts"), globals);
  process.stderr.write(
    `[consumer] ${count} examples of the READMEs and of ${documents.join(", ")}\n`,
  );
  return target;
}

/** Copies the runnable examples (`examples/*.ts`) into `runnable/` */
function copyRunnable() {
  const target = join(dir, "runnable");
  mkdirSync(target);
  const source = join(root, "examples");
  const files = readdirSync(source).filter((file) => file.endsWith(".ts"));
  for (const { file } of examples) {
    if (!files.includes(`${file}.ts`)) {
      throw new Error(`examples/${file}.ts is missing (scripts/examples.mjs)`);
    }
  }
  for (const file of files) {
    copyFileSync(join(source, file), join(target, file));
  }
  process.stderr.write(`[consumer] ${files.length} runnable examples\n`);
  return target;
}

/** Checks that every archive declares the packages that its `dist/` imports */
function checkImports(tarballs) {
  const errors = tarballs.flatMap((path) => {
    const files = readTarball(readFileSync(path));
    const manifest = JSON.parse(files.get("package.json"));
    return undeclaredImports(manifest, files);
  });
  if (errors.length > 0) {
    throw new Error(`Undeclared imports:\n  ${errors.join("\n  ")}`);
  }
  process.stderr.write(
    `[consumer] the imports of ${tarballs.length} archives are declared\n`,
  );
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

/** The prepared archives of `--tarballs <dir>`, or the workspaces packed into `dir` */
function pack() {
  const index = process.argv.indexOf("--tarballs");
  if (index !== -1) {
    const prepared = process.argv[index + 1] ?? "";
    if (prepared === "" || prepared.startsWith("--")) {
      throw new Error("Usage: scripts/consumer-check.mjs --tarballs <dir>");
    }
    const archives = readRelease(resolve(prepared));
    process.stderr.write(
      `[consumer] ${archives.length} prepared archives of ${prepared}\n`,
    );
    return archives.map(({ path }) => path);
  }
  run(
    "npm",
    ["pack", "--workspaces", "--pack-destination", dir, "--loglevel=warn"],
    root,
  );
  return readdirSync(dir)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => join(dir, file));
}

/**
 * Installs each tarball alone (with `--install-strategy=nested`) into a project of
 * its own, outside of `dir` (whose `node_modules` would hide a missing
 * dependency): npm installs its dependencies and peers, which `overrides` take
 * from the other tarballs. The project is type checked (with the TypeScript and
 * `@types/node` of `dir`), then the package is imported: its root, and its
 * `package.json` (as JSON), while a module of `dist/` is not exported.
 */
function checkStandalone(tarballs) {
  const packages = tarballs.map((path) => {
    const files = readTarball(readFileSync(path));
    const modules = [...files.keys()]
      .filter((file) => /^dist\/.+\.js$/u.test(file))
      .sort();
    // A module of the package that its `exports` do not export (deep imports are closed)
    const deep =
      modules.find((file) => file.startsWith("dist/src/")) ?? modules[0];
    return { name: JSON.parse(files.get("package.json")).name, path, deep };
  });
  for (const { name, path, deep } of packages) {
    const project = mkdtempSync(join(tmpdir(), "binden-standalone-"));
    try {
      process.stderr.write(`[consumer] ${name} alone\n`);
      const overrides = Object.fromEntries(
        packages
          .filter((other) => other.name !== name)
          .map((other) => [other.name, `file:${other.path}`]),
      );
      writeFileSync(
        join(project, "package.json"),
        `${JSON.stringify({ private: true, type: "module", overrides })}\n`,
      );
      run(
        "npm",
        [
          "install",
          "--install-strategy=nested",
          "--no-audit",
          "--no-fund",
          "--loglevel=warn",
          path,
        ],
        project,
      );
      writeFileSync(
        join(project, "index.ts"),
        `import * as module from ${JSON.stringify(name)};\n\nexport const names: string[] = Object.keys(module);\n`,
      );
      writeFileSync(
        join(project, "tsconfig.json"),
        `${JSON.stringify({
          compilerOptions: {
            module: "nodenext",
            target: "es2022",
            strict: true,
            noEmit: true,
            types: ["node"],
            typeRoots: [join(dir, "node_modules", "@types")],
          },
          files: ["index.ts"],
        })}\n`,
      );
      run(
        process.execPath,
        [join(dir, "node_modules/typescript/bin/tsc"), "-p", project],
        project,
      );
      // Its root has exports, its `package.json` is exported, its modules are not
      run(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `const name = ${JSON.stringify(name)};
const module = await import(name);
if (Object.keys(module).length === 0) {
  throw new Error(\`\${name} has no exports\`);
}
const { default: manifest } = await import(\`\${name}/package.json\`, {
  with: { type: "json" },
});
if (manifest.name !== name) {
  throw new Error(\`The package.json of \${name} names \${manifest.name}\`);
}
const deep = ${JSON.stringify(`${name}/${deep}`)};
await import(deep).then(
  () => {
    throw new Error(\`\${deep} is exported\`);
  },
  (error) => {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      throw error;
    }
  },
);`,
        ],
        project,
      );
    } finally {
      rmSync(project, { force: true, recursive: true });
    }
  }
}

try {
  const tarballs = pack();
  checkImports(tarballs);

  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ private: true, type: "module" })}\n`,
  );
  writeFileSync(join(dir, "consumer.ts"), consumer);
  const snippets = writeSnippets();
  const runnable = copyRunnable();

  for (const [round, { typescript, types, skipLibCheck }] of [
    {
      typescript: devDependencies.typescript,
      types: "24",
      skipLibCheck: false,
    },
    { typescript: devDependencies.typescript, types: "26", skipLibCheck: true },
    { typescript: "7", types: "24", skipLibCheck: false },
  ].entries()) {
    process.stderr.write(
      `[consumer] typescript@${typescript}, @types/node@${types}\n`,
    );
    run("npm", [
      "install",
      // Every package gets its own node_modules: an import of a dependency that
      // is not declared (but hoisted in this repository) fails
      "--install-strategy=nested",
      "--no-audit",
      "--no-fund",
      "--loglevel=warn",
      ...tarballs,
      `typescript@${typescript}`,
      `@types/node@${types}`,
      ...Object.entries(exampleDependencies).map(
        ([name, version]) => `${name}@${version}`,
      ),
    ]);
    const tsc = join(dir, "node_modules/typescript/bin/tsc");
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
    run(process.execPath, [tsc, "-p", dir]);
    run(process.execPath, [join(dir, "dist/consumer.js")]);

    // Each example is a module (`moduleDetection`), checked as strictly as the consumer
    writeFileSync(
      join(snippets, "tsconfig.json"),
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
    run(process.execPath, [tsc, "-p", snippets]);

    // The runnable examples, as strictly as in this repository (`exactOptionalPropertyTypes`),
    // compiled
    writeFileSync(
      join(runnable, "tsconfig.json"),
      `${JSON.stringify({
        compilerOptions: {
          module: "nodenext",
          target: "es2022",
          strict: true,
          exactOptionalPropertyTypes: true,
          skipLibCheck,
          types: ["node"],
          outDir: "dist",
        },
        include: ["*.ts"],
      })}\n`,
    );
    run(process.execPath, [tsc, "-p", runnable]);

    if (round === 0) {
      if (process.platform === "win32") {
        process.stderr.write("[consumer] the examples are run on POSIX only\n");
      } else {
        for (const example of examples) {
          process.stderr.write(`[consumer] example ${example.name}\n`);
          await runExample(example, {
            command: process.execPath,
            args: [join(runnable, "dist", `${example.file}.js`)],
            cwd: dir,
          });
        }
      }
      checkStandalone(tarballs);
    }
  }
  process.stderr.write("[consumer] OK\n");
} finally {
  rmSync(dir, { force: true, recursive: true });
}
