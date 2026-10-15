import { Binden, type Context } from "../index.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { listen, send } from "./helpers.js";
import { suite, test } from "node:test";

suite("Context (response helpers)", () => {
  test("redirect(), sendFile() and json() send the response and set `done`", async () => {
    const reached: string[] = [];
    const app = new Binden()
      .use("/redirect", (context: Context) => context.redirect("/x?y=1"))
      .use("/moved", (context: Context) =>
        context.redirect(new URL("https://example.com/"), 301, {
          allow_external: true,
        }),
      )
      .use("/file", (context: Context) =>
        context.sendFile(import.meta.filename, { content_type: "text/x-test" }),
      )
      .use("/json", (context: Context) =>
        context.json(["a", 1], (value: (number | string)[]): string =>
          JSON.stringify({ value }),
        ),
      )
      .use("/string", (context: Context) => context.json("text"))
      .use((context: Context) => {
        reached.push(context.url.pathname);
      });
    const listening = await listen(app);
    const { port } = listening;
    try {
      const redirect = await send(port, { path: "/redirect" });
      deepStrictEqual(
        [redirect.status, redirect.headers.location, redirect.body],
        [302, "/x?y=1", ""],
      );
      const moved = await send(port, { path: "/moved" });
      deepStrictEqual(
        [moved.status, moved.headers.location],
        [301, "https://example.com/"],
      );
      const file = await send(port, { path: "/file" });
      deepStrictEqual(file.headers["content-type"], "text/x-test");
      ok(file.body.includes("Context (response helpers)"));
      deepStrictEqual(
        (await send(port, { path: "/json" })).body,
        '{"value":["a",1]}',
      );
      deepStrictEqual((await send(port, { path: "/string" })).body, '"text"');
      deepStrictEqual(reached, []);
    } finally {
      await listening.close();
    }
  });

  test("attachment(), type(), vary() and clearCookie() set the headers", async () => {
    const app = new Binden().use((context: Context) =>
      context
        .attachment("é.txt")
        .type("text/plain; charset=utf-8")
        .vary("Accept", "accept-language")
        .clearCookie("session", { path: "/" })
        .send("x"),
    );
    const listening = await listen(app);
    const { port } = listening;
    try {
      const { headers } = await send(port);
      deepStrictEqual(
        [headers["content-disposition"], headers["content-type"], headers.vary],
        [
          `attachment; filename="_.txt"; filename*=UTF-8''%C3%A9.txt`,
          "text/plain; charset=utf-8",
          "Accept, accept-language",
        ],
      );
      ok(String(headers["set-cookie"]).startsWith("session=; "));
    } finally {
      await listening.close();
    }
  });
});
