import { body, part, post, send, serve } from "./helpers.js";
import { deepEqual, equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import multipart, { MultipartFile, multipartInfo } from "../index.js";
import type { Context } from "binden";

describe("multipartInfo()", () => {
  it("tells the truncated fields and the reached limits (`throw_limits: false`)", async (t) => {
    const seen: unknown[] = [];
    const { url } = await serve(t, [
      (context: Context): void => {
        seen.push(multipartInfo(context));
      },
      multipart({
        throw_limits: false,
        config: { limits: { fieldSize: 3, fields: 2, files: 1, parts: 5 } },
      }),
      async (context: Context): Promise<void> => {
        const info = multipartInfo(context);
        ok(info !== null);
        ok(Object.isFrozen(info));
        ok(Object.isFrozen(info.truncated_fields));
        ok(Object.isFrozen(info.limits_hit));
        const form = context.request.body as FormData;
        seen.push(info, [...form.keys()]);
        await context.send();
      },
    ]);

    const reply = await post(
      url,
      body(
        part('name="a"', "abcdef"),
        part('name="b"', "xy"),
        part('name="c"', "dropped (`fields`)"),
        part('name="f1"; filename="f1.txt"', "1"),
        part('name="f2"; filename="f2.txt"', "dropped (`files`)"),
        part('name="d"', "dropped (`parts`)"),
      ),
    );

    equal(reply.status, 200);
    deepEqual(seen, [
      null,
      { truncated_fields: ["a"], limits_hit: ["fields", "files", "parts"] },
      ["a", "b", "f1"],
    ]);
  });

  it("tells the limit that has refused a request", async (t) => {
    const seen: unknown[] = [];
    const { url } = await serve(
      t,
      [multipart({ config: { limits: { files: 0 } } })],
      {
        error_handler: async (context: Context): Promise<void> => {
          seen.push(multipartInfo(context));
          await context.status(413).send();
        },
      },
    );

    const reply = await post(url, body(part('name="f"; filename="f"', "1")));

    equal(reply.status, 413);
    deepEqual(seen, [{ truncated_fields: [], limits_hit: ["files"] }]);
  });

  it("is `null` for a request that `Multipart` has not parsed", async (t) => {
    const seen: unknown[] = [];
    const { url } = await serve(t, [
      multipart(),
      async (context: Context): Promise<void> => {
        seen.push(multipartInfo(context));
        await context.send();
      },
    ]);

    await send(url, { method: "GET" });
    await send(url, { headers: { "Content-Type": "text/plain" }, body: "a" });
    await post(url, body(part('name="a"', "1")));

    deepEqual(seen, [null, null, { truncated_fields: [], limits_hit: [] }]);
  });
});

describe("MultipartFile", () => {
  it("is a `File` that tells whether it has been truncated", async () => {
    const file = new MultipartFile(["abc"], "a.txt", { type: "text/plain" });
    const truncated = new MultipartFile(["ab"], "b.txt", { truncated: true });

    ok(file instanceof File);
    deepEqual(
      [file.name, file.type, await file.text(), file.truncated],
      ["a.txt", "text/plain", "abc", false],
    );
    deepEqual([truncated.name, truncated.truncated], ["b.txt", true]);
  });

  it("is the file of the memory storage", async (t) => {
    const files: unknown[] = [];
    const { url } = await serve(t, [
      multipart({ throw_limits: false, config: { limits: { fileSize: 2 } } }),
      async (context: Context): Promise<void> => {
        for (const value of (context.request.body as FormData).values()) {
          ok(value instanceof MultipartFile);
          files.push([value.name, await value.text(), value.truncated]);
        }
        await context.send();
      },
    ]);

    const reply = await post(
      url,
      body(
        part('name="a"; filename="a.txt"', "1"),
        part('name="b"; filename="b.txt"', "123"),
      ),
    );

    equal(reply.status, 200);
    deepEqual(files, [
      ["a.txt", "1", false],
      ["b.txt", "12", true],
    ]);
  });
});
