import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { suite, test } from "node:test";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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
  readonly probes: number;
  readonly findings: readonly IFinding[];
}

/**
 * The entry points whose findings are being fixed (by their ids), while the
 * fixes are integrated: each must still have a finding (a fixed one is
 * removed from the list), and the list is empty once they are
 */
const integrating: readonly string[] = [
  // binden/src/response.ts and @binden/compression
  "binden:BindenResponse#[binden.negotiator]()",
  "binden:BindenResponse#[binden.operation]()=>.run()",
  "binden:BindenResponse#[binden.validate_head]()",
  "binden:BindenResponse#addTrailers()",
  "binden:BindenResponse#cookies=>.add()",
  "binden:BindenResponse#writeEarlyHints()",
  "binden:BindenResponse#writeHead()",
  "binden:BindenResponse#writeHeader()",
  "@binden/compression:Compression#run()",
  "@binden/compression:Compression#run()=>0.response.writeHead()",
  "@binden/compression:new Compression()",
  // @binden/body, @binden/multipart, binden/src/binden.ts, error.ts and
  // headers/content-type.ts
  "@binden/body:BodyParser#run()",
  "@binden/multipart:new MultipartFile()",
  "binden:Binden#callback()=>()",
  // binden/src/request.ts, context.ts and logger.ts
  "binden:createSerializers()=>.context()",
  "binden:new BindenRequest()",
  "binden:new Context()",
  "binden:serializers.context()",
];

/**
 * Runs the fixture of the public surface in a process of its own (it sets
 * `Error.prepareStackTrace` and listens for the late failures of the process),
 * bounded: it stops itself after 100 s
 */
function surveyed(): IReport {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", "public-surface.ts"),
    ],
    { encoding: "utf8", timeout: 110_000 },
  );
  strictEqual(stderr, "");
  strictEqual(status, 0);
  return JSON.parse(stdout) as IReport;
}

suite("The public surface of the packages of binden", () => {
  test(
    "every entry point (each export, constructor, static and prototype member of every package, also by a symbol, and what they return or install) has a validated baseline, and formats what it throws or rejects with for a hostile value in any argument position (also once a response is sent, ended or destroyed, and in what reads what it stores), passes an error of the application on as itself, reads each option once, examines each position, and refuses without a conversion that is not documented, made as often as documented",
    { timeout: 120_000 },
    () => {
      const { entries, probes, findings } = surveyed();
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
      deepStrictEqual(
        findings
          .filter(({ entry }) => !integrating.includes(entry))
          .map(({ entry, probe, what }) => `${entry} | ${probe}: ${what}`),
        [],
      );
      deepStrictEqual(
        integrating.filter((id) => !findings.some(({ entry }) => entry === id)),
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
