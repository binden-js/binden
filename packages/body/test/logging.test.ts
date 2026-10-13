import { deepStrictEqual, ok } from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { suite, test } from "node:test";
import { Logger } from "@binden/logger";
import { Binden, ct_json, serializers } from "binden";
import { request } from "undici";

import { BodyParser } from "../index.js";

// Invalid JSON: the error of `JSON.parse()` quotes the body
const body = '{"password": SECRET}';

/** Posts the body and returns the response status and the log lines */
async function post(
  logger: (destination: { write(line: string): void }) => Logger,
): Promise<[number, string]> {
  const lines: string[] = [];
  const destination = {
    write: (line: string): void => {
      lines.push(line);
    },
  };
  const app = new Binden({ logger: logger(destination) }).use(new BodyParser());
  const server: Server = app.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, resolve);
  });
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;

  try {
    const response = await request(url, {
      method: "POST",
      headers: { "Content-Type": ct_json },
      body,
    });
    await response.body.dump();
    return [response.statusCode, lines.join("")];
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
}

suite("BodyParser (logging)", () => {
  test("keeps the body out of the default logs", async () => {
    const [status, output] = await post(
      (destination) => new Logger({ serializers, destination, level: "debug" }),
    );

    deepStrictEqual(status, 415);
    ok(output.includes("Request body does not match provided Content-Type"));
    ok(output.includes('"body":"[Redacted]"'), output);
    ok(!output.includes("SECRET"), output);
  });

  test("logs the body with a custom serializer", async () => {
    const [status, output] = await post(
      (destination) =>
        new Logger({
          serializers: {
            ...serializers,
            body: (input: unknown): unknown => input,
          },
          destination,
          level: "debug",
        }),
    );

    deepStrictEqual(status, 415);
    ok(output.includes(`"body":${JSON.stringify(body)}`), output);
  });
});
