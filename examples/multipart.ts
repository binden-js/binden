// File uploads with explicit limits: to the disk, where the application keeps
// (`persist()`) the files it wants and the others are removed with their request,
// or streamed to a handler (here a checksum) without being kept at all.
//
//   UPLOAD_DIR=/var/lib/uploads PORT=3000 node --import tsx examples/multipart.ts
//   curl -F title=Report -F document=@report.pdf http://localhost:3000/documents
//   curl -F file=@archive.tar http://localhost:3000/checksums
import { Binden, BindenError, type Context, Router, shutdown } from "binden";
import {
  type IFileInfo,
  type IStoredForm,
  type IStreamFile,
  Multipart,
} from "@binden/multipart";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const MiB = 1024 * 1024;
// The limits suggested for production: the whole body, each file, and the counts
const limits = { fileSize: 5 * MiB, files: 10, fields: 100, parts: 1000 };

// The kept files, and the private directories of the requests in progress (on the
// same file system: `persist()` moves a file with a hard link)
const documents = process.env.UPLOAD_DIR ?? join(tmpdir(), "binden-uploads");
const incoming = join(documents, ".incoming");
mkdirSync(incoming, { recursive: true });

// What a file declares is chosen by the client: check the content too when it matters
const accepted = new Set(["application/pdf", "image/png", "text/plain"]);
const fileFilter = ({ mime_type }: IFileInfo): boolean =>
  accepted.has(mime_type);

const disk = new Multipart({
  limit: 10 * MiB,
  config: { limits },
  storage: { dir: incoming },
  file_filter: fileFilter,
});

const keep = async (context: Context): Promise<void> => {
  const { fields, files } = context.request.body as IStoredForm;
  const kept = [];
  for (const file of files.get("document") ?? []) {
    // A name of the application: the name that the client has sent is metadata
    const name = `${randomUUID()}.bin`;
    await file.persist(join(documents, name));
    kept.push({ name, filename: file.filename, size: file.size });
  }
  if (kept.length === 0) {
    throw new BindenError(400, { expose: true, message: "No document" });
  }
  await context
    .status(201)
    .json({ title: fields.get("title")?.[0] ?? null, kept });
};

/** The checksums of the files of a request, by field (in the state of the request) */
function checksums(context: Context): Record<string, string> {
  context.state.checksums ??= {};
  return context.state.checksums as Record<string, string>;
}

const stream = new Multipart({
  limit: 10 * MiB,
  config: { limits },
  storage: {
    on_file: async (file: IStreamFile, context: Context): Promise<void> => {
      const hash = createHash("sha256");
      for await (const chunk of file.stream) {
        hash.update(chunk as Buffer);
      }
      if (file.truncated()) {
        throw new BindenError(413);
      }
      checksums(context)[file.field] = hash.digest("hex");
    },
  },
});

const sums = (context: Context): Promise<void> =>
  context.json(checksums(context));

export const app = new Binden({ timeout: 30_000 })
  .use("/documents", new Router().post(disk, keep))
  .use("/checksums", new Router().post(stream, sums));

export const server = app.createServer({
  headersTimeout: 20_000,
  requestTimeout: 120_000,
  keepAliveTimeout: 65_000,
});

server.listen(Number(process.env.PORT ?? 3000), () => {
  const { port } = server.address() as AddressInfo;
  process.stdout.write(`Listening on http://localhost:${port}\n`);
});

process.once("SIGTERM", () => {
  shutdown(server, { timeout: 20_000, cleanup_timeout: 2000 }).catch(
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
});
