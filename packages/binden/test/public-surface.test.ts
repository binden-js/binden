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
 * Runs the fixture of the public surface in a process of its own (it sets
 * `Error.prepareStackTrace` and listens for the late failures of the process),
 * bounded: it stops itself after 45 s
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
    { encoding: "utf8", timeout: 50_000 },
  );
  strictEqual(stderr, "");
  strictEqual(status, 0);
  return JSON.parse(stdout) as IReport;
}

/**
 * The entry points whose findings are tolerated while the formatting of every
 * entry point (round 27, item 1) is integrated: the list only shrinks, and is
 * empty once it is
 */
const integrating: readonly string[] = [
  "@binden/body:BodyParser#run()",
  "@binden/body:new BodyParser()",
  "@binden/compression:Compression#run()",
  "@binden/compression:isCompressible()",
  "@binden/compression:new Compression()",
  "@binden/compression:skipCompression()",
  "@binden/logger:Logger#child()",
  "@binden/logger:Logger#error()",
  "@binden/logger:Logger#fatal()",
  "@binden/logger:Logger#info()",
  "@binden/logger:Logger#isLevelEnabled()",
  "@binden/logger:Logger#level =",
  "@binden/logger:Logger#warn()",
  "@binden/logger:Logger.fromPino()",
  "@binden/logger:Logger.getLevel()",
  "@binden/logger:createSerializers()",
  "@binden/logger:new Logger()",
  "@binden/multipart:Multipart#run()",
  "@binden/multipart:default()",
  "@binden/multipart:multipartInfo()",
  "@binden/multipart:new Multipart()",
  "@binden/multipart:new MultipartFile()",
  "binden:Accept.fromString()",
  "binden:Accept.negotiate()",
  "binden:AcceptCharset.fromString()",
  "binden:AcceptCharset.negotiate()",
  "binden:AcceptEncoding.fromString()",
  "binden:AcceptEncoding.negotiate()",
  "binden:AcceptLanguage.fromString()",
  "binden:AcceptLanguage.negotiate()",
  "binden:Authorization.fromString()",
  "binden:Binden#callback()",
  "binden:Binden#callback()=>()",
  "binden:Binden#createSecureServer()",
  "binden:Binden#createServer()",
  "binden:BindenRequest#accepts()",
  "binden:BindenRequest#acceptsCharsets()",
  "binden:BindenRequest#acceptsEncodings()",
  "binden:BindenRequest#acceptsLanguages()",
  "binden:BindenRequest#header()",
  "binden:BindenResponse#[binden.framework]()",
  "binden:BindenResponse#[binden.listen]()",
  "binden:BindenResponse#[binden.restoreFraming]()",
  "binden:BindenResponse#[binden.revoke]()",
  "binden:BindenResponse#[binden.validate_head]()",
  "binden:BindenResponse#addListener()",
  "binden:BindenResponse#addTrailers()",
  "binden:BindenResponse#appendHeader()",
  "binden:BindenResponse#destroy()",
  "binden:BindenResponse#emit()",
  "binden:BindenResponse#end()",
  "binden:BindenResponse#getHeader()",
  "binden:BindenResponse#on()",
  "binden:BindenResponse#once()",
  "binden:BindenResponse#prependListener()",
  "binden:BindenResponse#prependOnceListener()",
  "binden:BindenResponse#rawListeners()",
  "binden:BindenResponse#removeHeader()",
  "binden:BindenResponse#sendFile()",
  "binden:BindenResponse#set()",
  "binden:BindenResponse#setHeader()",
  "binden:BindenResponse#setHeaders()",
  "binden:BindenResponse#setTimeout()",
  "binden:BindenResponse#write()",
  "binden:BindenResponse#writeEarlyHints()",
  "binden:BindenResponse#writeHead()",
  "binden:BindenResponse#writeHeader()",
  "binden:BindenResponse#writeInformation()",
  "binden:ContentEncoding.fromString()",
  "binden:ContentRange.fromString()",
  "binden:ContentType.fromString()",
  "binden:Context#sendFile()",
  "binden:Context#setHeader()",
  "binden:Context#throw()",
  "binden:Forwarded.fromString()",
  "binden:Forwarded.parse()",
  "binden:IfModifiedSince.fromString()",
  "binden:Range.fromString()",
  "binden:Router#delete()",
  "binden:Router#get()",
  "binden:Router#head()",
  "binden:Router#middlewares=>()",
  "binden:Router#off()",
  "binden:Router#on()",
  "binden:Router#options()",
  "binden:Router#patch()",
  "binden:Router#post()",
  "binden:Router#put()",
  "binden:Router#trace()",
  "binden:Stack#mount()",
  "binden:Stack#off()",
  "binden:Stack#route()",
  "binden:Stack#use()",
  "binden:createSerializers()",
  "binden:framingLength()",
  "binden:new Accept()",
  "binden:new AcceptCharset()",
  "binden:new AcceptEncoding()",
  "binden:new AcceptLanguage()",
  "binden:new Authorization()",
  "binden:new Binden()",
  "binden:new BindenAbortError()",
  "binden:new BindenError()",
  "binden:new BindenRequest()",
  "binden:new BindenResponse()",
  "binden:new ContentEncoding()",
  "binden:new ContentRange()",
  "binden:new ContentType()",
  "binden:new Context()",
  "binden:new Cookie()",
  "binden:new Forwarded()",
  "binden:new IfModifiedSince()",
  "binden:new Middleware()",
  "binden:new Range()",
  "binden:new Router()",
  "binden:serializers.context()",
  "binden:shutdown()",
  "binden:validateRequestOptions()",
  "binden:validateResponseOptions()",
];

suite("The public surface of the packages of binden", () => {
  test("every entry point (each export, constructor, static and prototype member of every package, also by a symbol) has a validated baseline, and formats what it throws or rejects with for a hostile value in any argument position, passes an error of the application on as itself, and refuses without a conversion that is not documented", () => {
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
    // The tolerated entry points exist
    deepStrictEqual(
      integrating.filter((id) => !entries.includes(id)),
      [],
    );
    deepStrictEqual(
      findings
        .filter(({ entry }) => !integrating.includes(entry))
        .map(({ entry, probe, what }) => `${entry} | ${probe}: ${what}`),
      [],
    );
  });
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
      test(
        how,
        { todo: "until the formatting of every entry point is integrated" },
        () => {
          const { status, stdout, stderr } = spawnSync(
            process.execPath,
            [
              "--expose-gc",
              "--no-warnings",
              "--import",
              "tsx",
              join(
                import.meta.dirname,
                "fixtures",
                "created-error-retention.ts",
              ),
              mode,
            ],
            { encoding: "utf8", timeout: 30_000 },
          );
          // 60 requests, whose errors are kept
          deepStrictEqual(
            { status, stdout, stderr },
            { status: 0, stdout: "collected 60 TypeError\n", stderr: "" },
          );
        },
      );
    }
  },
);
