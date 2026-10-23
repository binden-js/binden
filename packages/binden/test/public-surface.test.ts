import { deepStrictEqual, ok } from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { suite, test } from "node:test";
import { join } from "node:path";
import { once } from "node:events";

/** A finding of `fixtures/public-surface.ts` */
interface IFinding {
  readonly entry: string;
  readonly probe: string;
  readonly what: string;
}

/** The report of `fixtures/public-surface.ts` */
interface IReport {
  /** The ids of the entry points that it has enumerated */
  readonly entries: readonly string[];
  /** The ids of the entry points that it has probed (of its shard) */
  readonly probed: readonly string[];
  readonly probes: number;
  readonly findings: readonly IFinding[];
}

/**
 * The findings being fixed (`<entry> | <probe>` prefixes), until their fixes
 * are integrated: each must still have a finding
 */
const integrating: readonly string[] = [];

/** How many processes probe the surface in parallel, each a shard of it */
const shards = 4;
/** How long a shard may run before it is killed */
const killMs = 110_000;
/**
 * How long a shard may run before it stops itself, saying so (derived from
 * `killMs`, which stays above it): a run that is too slow is told from one
 * that hangs
 */
const timeoutMs = killMs - 10_000;

/**
 * Runs a shard of the fixture of the public surface in a process of its own
 * (it sets `Error.prepareStackTrace` and listens for the late failures of the
 * process), bounded: it stops itself after `timeoutMs`, and is killed after
 * `killMs`
 */
async function survey(shard: number): Promise<IReport> {
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", "public-surface.ts"),
      `--shard=${String(shard)}/${String(shards)}`,
      `--timeout=${String(timeoutMs)}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"], timeout: killMs },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [status, signal] = (await once(child, "close")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  deepStrictEqual(
    { shard, status, signal, stderr },
    { shard, status: 0, signal: null, stderr: "" },
  );
  return JSON.parse(stdout) as IReport;
}

/**
 * The reports of every shard, together: every entry point that a shard has
 * enumerated is probed by one shard, once
 */
async function surveyed(): Promise<IReport> {
  const reports = await Promise.all(
    Array.from({ length: shards }, (_, shard) => survey(shard)),
  );
  const entries = new Set(reports.flatMap(({ entries: ids }) => ids));
  const probed = reports.flatMap(({ probed: ids }) => ids);
  const unique = new Set(probed);
  deepStrictEqual(
    {
      "probed by no shard": [...entries].filter((id) => !unique.has(id)),
      "probed twice": probed.filter(
        (id, index) => probed.indexOf(id) !== index,
      ),
      "probed, not enumerated": [...unique].filter((id) => !entries.has(id)),
    },
    {
      "probed by no shard": [],
      "probed twice": [],
      "probed, not enumerated": [],
    },
  );
  return {
    entries: [...entries],
    probed,
    probes: reports.reduce((sum, { probes }) => sum + probes, 0),
    findings: reports.flatMap(({ findings }) => findings),
  };
}

suite("The public surface of the packages of binden", () => {
  test(
    "every entry point (each export, constructor, static and prototype member of every package, also by a symbol, and what they return or install) has a validated baseline, and formats what it throws or rejects with for a hostile value in any argument position (also once a response is sent, ended or destroyed, and in what reads what it stores), passes an error of the application on as itself, reads each option once, examines each position, and refuses without a conversion that is not documented, made as often as documented",
    { timeout: killMs + 10_000 },
    async () => {
      const { entries, probes, findings } = await surveyed();
      // Not vacuous: every package has entry points, each one probed
      for (const name of [
        "binden",
        "@binden/logger",
        "@binden/body",
        "@binden/compression",
        "@binden/multipart",
      ]) {
        ok(
          entries.some((id) => id.startsWith(`${name}:`)),
          name,
        );
      }
      ok(probes > entries.length * 5, String(probes));
      const lines = findings.map(
        ({ entry, probe, what }) => `${entry} | ${probe}: ${what}`,
      );
      deepStrictEqual(
        lines.filter(
          (line) => !integrating.some((prefix) => line.startsWith(prefix)),
        ),
        [],
      );
      deepStrictEqual(
        integrating.filter(
          (prefix) => !lines.some((line) => line.startsWith(prefix)),
        ),
        [],
        "fixed: remove them from `integrating`",
      );
    },
  );
});

suite(
  "A refusal of an entry point that formats what it throws, kept by the application without its stack read, keeps neither the request nor the response",
  () => {
    for (const [mode, how] of [
      ["cookieNull", "of `new Cookie(null)`"],
      ["acceptsSymbol", "of `request.accepts(Symbol())`"],
      ["headerNull", "of `request.header(null)`"],
      ["errorRevoked", "of `new BindenError(500, revoked)`"],
      ["sendFileRevoked", "of `response.sendFile(revoked)`"],
      ["setHeaderSymbol", "of `response.setHeader(Symbol())`, by Node.js"],
      [
        "compressionEncoding",
        "of the encoding of a write through @binden/compression",
      ],
    ] as const) {
      test(how, () => {
        const { status, stdout, stderr } = spawnSync(
          process.execPath,
          [
            "--expose-gc",
            "--no-warnings",
            "--import",
            "tsx",
            join(import.meta.dirname, "fixtures", "created-error-retention.ts"),
            mode,
          ],
          { encoding: "utf8", timeout: 30_000 },
        );
        // 60 requests, whose errors are kept
        deepStrictEqual(
          { status, stdout, stderr },
          { status: 0, stdout: "collected 60 TypeError\n", stderr: "" },
        );
      });
    }
  },
);
