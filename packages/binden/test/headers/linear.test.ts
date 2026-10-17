import {
  AcceptEncoding,
  Authorization,
  BindenRequest,
  BindenResponse,
  Range,
} from "../../index.js";
import { deepStrictEqual, ok, throws } from "node:assert";
import { suite, test } from "node:test";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { Worker } from "node:worker_threads";
import { once } from "node:events";

/**
 * The milliseconds of CPU time (user and system) that the current thread has
 * taken since `start`, a `process.threadCpuUsage()`: unlike the time of the
 * clock, it does not grow while other processes load the machine, nor with
 * the threads of V8 that compile and collect in the background (which
 * `process.cpuUsage()`, of the whole process, counts)
 */
function cpuSince(start: NodeJS.CpuUsage): number {
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / 1000;
}

/** The milliseconds of CPU time that `fn` takes (see `cpuSince()`) */
function duration(fn: () => unknown): number {
  const start = process.threadCpuUsage();
  fn();
  return cpuSince(start);
}

/**
 * The length of a header that Node.js accepts (`maxHeaderSize`, 16 KiB): a
 * parser that backtracks polynomially on it takes hundreds of milliseconds
 */
const length = 15_000;

/** A bound (of CPU time) far above a linear parse, far below a quadratic one */
const bound = 100;

/**
 * The message of a fixture (`test/fixtures`) run in a worker thread, which is
 * terminated after `ms` milliseconds: an exponential backtracking (that a test
 * in the same thread could not stop) fails the test instead of hanging it
 */
async function inWorker(fixture: string, ms: number): Promise<unknown> {
  const worker = new Worker(new URL(`../fixtures/${fixture}`, import.meta.url));
  const timer = setTimeout(() => {
    worker.terminate().catch(() => null);
  }, ms);
  try {
    const [message] = (await Promise.race([
      once(worker, "message"),
      once(worker, "exit").then(() => [new Error("Terminated")]),
    ])) as [unknown];
    return message;
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

suite("Header parsers in linear time", () => {
  test("Authorization: a scheme followed by a long run of spaces", () => {
    // A line terminator, which `.` does not match, after the spaces
    const input = `! ${" ".repeat(length)}\u2028x`;
    ok(duration(() => Authorization.fromString(input)) < bound);
    deepStrictEqual(Authorization.fromString(input), null);
    deepStrictEqual(
      Authorization.fromString("Basic   abc")?.toString(),
      "Basic abc",
    );
  });

  test("Range: long runs of tabs around an empty position", () => {
    for (const input of [
      `bytes=${"\t".repeat(length)}x`,
      `bytes=-${"\t".repeat(length)}x`,
    ]) {
      ok(duration(() => Range.fromString(input)) < bound);
      deepStrictEqual(Range.fromString(input), []);
    }
    deepStrictEqual(Range.fromString("bytes= \t1 - 2 \t, \t-5").map(String), [
      "bytes=1-2",
      "bytes=-5",
    ]);
  });

  test("Accept-Encoding: a weight followed by a long run of spaces", () => {
    const input = `gzip;q=${" ".repeat(length)}x`;
    ok(duration(() => AcceptEncoding.fromString(input)) < bound);
    deepStrictEqual(AcceptEncoding.fromString(input), []);
    deepStrictEqual(AcceptEncoding.fromString("gzip; Q = 0.5").map(String), [
      "gzip;q=0.5",
    ]);
  });

  test("response.type(): long runs of ` ;`, whitespace and escapes", async () => {
    const results = (await inWorker("linear-media-type.ts", 20_000)) as {
      outcome: string;
      ms: number;
    }[];
    deepStrictEqual(
      results.map(({ outcome }) => outcome),
      [
        "TypeError",
        "TypeError",
        "TypeError",
        "TypeError",
        "TypeError",
        "TypeError",
      ],
    );
    for (const { ms } of results) {
      ok(ms < bound, `${ms} ms`);
    }
    // The grammar is unchanged
    const response = new BindenResponse(new IncomingMessage(new Socket()));
    deepStrictEqual(
      response
        .type(' \tText/Plain \t; ;\ta=b ; c="d;\\"e" \t')
        .getHeader("Content-Type"),
      'text/plain; a=b; c="d;\\"e"',
    );
  });

  test("an absolute-form request-target with a line terminator after a long path", () => {
    const request = new BindenRequest(new Socket());
    request.headers = { host: "localhost" };
    request.url = `http://${"a".repeat(length / 2)}/${"b".repeat(length / 2)}\n`;
    let ms = Number.POSITIVE_INFINITY;
    throws(() => {
      const start = process.threadCpuUsage();
      try {
        return request.URL;
      } finally {
        ms = cpuSince(start);
      }
    }, /Bad Request/u);
    ok(ms < bound, `${ms} ms`);
    request.url = "http://example.test:8080?a=b";
    deepStrictEqual(request.URL.href, "http://example.test:8080/?a=b");
  });
});
