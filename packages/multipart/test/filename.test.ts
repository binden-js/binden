import { body, part, post, serve } from "./helpers.js";
import { deepEqual, equal } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "binden";
import multipart from "../index.js";

/** A part of a file of the name, encoded as UTF-8 (RFC 8187) */
function file(name: string): string {
  return part(`name="f"; filename*=utf-8''${encodeURIComponent(name)}`, "");
}

describe("Multipart (file names)", () => {
  it("removes the control characters, keeps 255 bytes, and names an unnamed file `blob`", async (t) => {
    const names: string[] = [];
    const { url } = await serve(t, [
      multipart(),
      async (context: Context): Promise<void> => {
        for (const value of (context.request.body as FormData).values()) {
          names.push((value as File).name);
        }
        await context.send();
      },
    ]);
    const emoji = "😀";

    const reply = await post(
      url,
      body(
        file("a\u0000b\u0001c\td\u007fe\u0085f.txt"),
        file("invoice\u202Etxt.exe\u2066\u2069\u200E\u200F\u061C"),
        file("a".repeat(300)),
        file("я".repeat(200)),
        file(`${"a".repeat(253)}${emoji}`),
        file(`${"a".repeat(251)}${emoji}`),
        file("\u0001\u0002"),
        part('name="f"; filename=""', "", [
          "Content-Type: application/octet-stream",
        ]),
        part('name="f"', "", ["Content-Type: application/octet-stream"]),
      ),
    );

    equal(reply.status, 200);
    deepEqual(names, [
      "abcdef.txt",
      "invoicetxt.exe",
      "a".repeat(255),
      "я".repeat(127),
      "a".repeat(253),
      `${"a".repeat(251)}${emoji}`,
      "blob",
      "blob",
      "blob",
    ]);
  });
});
