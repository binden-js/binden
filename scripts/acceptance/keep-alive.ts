// A compressed reply of `send()` (a known length, which the compression removes)
// keeps its connection alive: it is framed as chunked, not by closing the
// connection.
import { deadline, exchange, serve } from "./helpers.js";
import { Agent } from "node:http";
import { Binden } from "binden";
import { Compression } from "@binden/compression";

deadline(10_000);

const app = new Binden()
  .use(new Compression())
  .use("/json", (context) => context.json({ text: "x".repeat(2000) }));
const { server, port } = await serve(app);
const agent = new Agent({ keepAlive: true, maxSockets: 1 });

const replies = [];
for (let index = 0; index < 3; index += 1) {
  const { headers, reused } = await exchange(port, "/json", {
    agent,
    headers: { "Accept-Encoding": "gzip" },
  });
  replies.push({
    reused,
    encoding: headers["content-encoding"],
    framing: headers["transfer-encoding"] ?? "close",
  });
}

agent.destroy();
server.close();
process.stdout.write(`${JSON.stringify(replies)}\n`);
