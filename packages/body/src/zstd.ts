// The decoding of the `zstd` content coding (RFC 8878) for `BodyParser`: an
// internal module, which the package does not export
import {
  type ZstdDecompress,
  constants,
  createZstdDecompress,
} from "node:zlib";
import { BindenError } from "binden";
import { Duplex } from "node:stream";

/**
 * A part of `zstd` data (RFC 8878, section 3.1): the magic number of a frame,
 * the descriptor, the `Window_Descriptor` and `Dictionary_ID` (`header`) and
 * the `Frame_Content_Size` (`fcs`) of a frame, the header (`block`) and the
 * `content` of a block, the `checksum` of a frame, or the `size` and the data
 * (`skip`) of a skippable frame
 */
type IZstdPart =
  | "block"
  | "checksum"
  | "content"
  | "descriptor"
  | "fcs"
  | "header"
  | "magic"
  | "size"
  | "skip";

/** The frames of the `zstd` codings of a request so far, shared by their decoders */
export interface IZstdFrameCount {
  frames: number;
}

/**
 * Bytes of a data frame within a chunk, for the decoder of that frame: the
 * first piece of a frame (`start`) comes after its magic number, and its
 * last piece (`end`) ends the frame
 */
export interface IZstdPiece {
  readonly bytes: Buffer;
  readonly start: boolean;
  readonly end: boolean;
  /**
   * The `Frame_Content_Size` of the frame, once its header has been read:
   * `null` when the frame does not declare it (or before its header)
   */
  readonly declared: bigint | null;
}

/**
 * The most `zstd` frames of a request (data, empty and skippable ones), over
 * every `zstd` coding of its body: each frame is a step of the decoding, so
 * that a body of tiny frames would cost much more than its size
 */
export const ZSTD_MAX_FRAMES = 1024;

/** The largest window of a `zstd` frame (8 MiB, RFC 9659) */
const ZSTD_WINDOW_LOG_MAX = 23;

/** The magic number of a `zstd` frame (RFC 8878, section 3.1.1) */
const ZSTD_MAGIC = 0xfd2fb528;

/** The magic number of a `zstd` frame, as its decoder gets it */
const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** The magic numbers of the skippable frames, without their last 4 bits (RFC 8878, section 3.1.2) */
const ZSTD_SKIPPABLE = 0x184d2a5;

/** The error of `zstd` data that is not a frame (e.g. after the end of the last one) */
const ZSTD_INVALID = "Invalid zstd frame";

/** The error of `zstd` data that has no frame, or ends within one */
const ZSTD_TRUNCATED = "Unexpected end of zstd data";

/** The error of a frame whose content is not of the size that it declares */
const ZSTD_SIZE = "The content of a zstd frame is not of its declared size";

/** The parts of `zstd` data that are read (the others are only counted) */
const zstdFields: ReadonlySet<IZstdPart> = new Set([
  "block",
  "descriptor",
  "fcs",
  "magic",
  "size",
]);

/**
 * Reads `zstd` data, and finds the ends of its frames (RFC 8878, section 3.1)
 * by their headers and the headers of their blocks, and the content size
 * that each frame declares. What is not a frame throws, and so does a frame
 * of the request beyond `ZSTD_MAX_FRAMES` (a `413 Content Too Large`, of code
 * `zstd_frames`).
 */
export class ZstdFrames {
  readonly #count: IZstdFrameCount;
  /** The bytes of the part being read, when it is a field (8 bytes at most) */
  readonly #field = Buffer.alloc(8);
  #part: IZstdPart = "magic";
  /** The size of the part, and how much of it has been read */
  #need = 4;
  #have = 0;
  /** Whether the frame has a checksum, and the block is its last one */
  #checksum = false;
  #last = false;
  /** Whether the part belongs to a data frame (after its magic number) */
  #data = false;
  /** The size of the `Frame_Content_Size` of the frame, and its value */
  #fcs = 0;
  #declared: bigint | null = null;

  /** Frames that count in `count` (shared by the codings of a request) */
  public constructor(count: IZstdFrameCount) {
    this.#count = count;
  }

  /** Whether the data ends between two frames (or before the first one) */
  public get complete(): boolean {
    return this.#part === "magic" && this.#have === 0;
  }

  /**
   * Reads a chunk whole: the pieces of the data frames in it, in order (the
   * magic numbers and the skippable frames are not in them, and the bytes of
   * two frames are never in one piece)
   */
  public scan(chunk: Buffer): IZstdPiece[] {
    const pieces: IZstdPiece[] = [];
    // Where the bytes of a data frame start in the chunk (`-1` outside of one)
    let from = this.#data ? 0 : -1;
    let start = false;
    let offset = 0;
    while (offset < chunk.byteLength) {
      const take = Math.min(this.#need - this.#have, chunk.byteLength - offset);
      if (zstdFields.has(this.#part)) {
        chunk.copy(this.#field, this.#have, offset, offset + take);
      }
      this.#have += take;
      offset += take;
      if (this.#have === this.#need) {
        do {
          this.#next();
        } while (this.#need === 0);
        if (this.#part === "magic" && from !== -1) {
          // The end of a data frame
          const bytes = chunk.subarray(from, offset);
          pieces.push({ bytes, start, end: true, declared: this.#declared });
          from = -1;
          start = false;
        } else if (this.#data && from === -1) {
          // The magic number of a data frame
          from = offset;
          start = true;
        }
      }
    }
    if (from !== -1) {
      const bytes = chunk.subarray(from);
      pieces.push({ bytes, start, end: false, declared: this.#declared });
    }
    return pieces;
  }

  /** Moves to the part after the one that has been read */
  #next(): void {
    const part = this.#part;
    if (part === "magic") {
      this.#magic();
    } else if (part === "descriptor") {
      this.#descriptor();
    } else if (part === "header") {
      this.#to("fcs", this.#fcs);
    } else if (part === "fcs") {
      this.#size();
      this.#to("block", 3);
    } else if (part === "content" && !this.#last) {
      this.#to("block", 3);
    } else if (part === "block") {
      this.#block();
    } else if (part === "content") {
      this.#to("checksum", this.#checksum ? 4 : 0);
    } else if (part === "size") {
      this.#to("skip", this.#field.readUInt32LE(0));
    } else {
      // The end of a frame (its `checksum`, or the data of a skippable one)
      this.#data = false;
      this.#to("magic", 4);
    }
  }

  /**
   * A regular frame, or a skippable one (which the decoder skips), within the
   * frames of the request: anything else is invalid (e.g. data after the
   * last frame)
   */
  #magic(): void {
    const magic = this.#field.readUInt32LE(0);
    if (magic === ZSTD_MAGIC) {
      this.#to("descriptor", 1);
    } else if (magic >>> 4 === ZSTD_SKIPPABLE) {
      this.#to("size", 4);
    } else {
      throw new Error(ZSTD_INVALID);
    }
    this.#count.frames += 1;
    if (this.#count.frames > ZSTD_MAX_FRAMES) {
      throw new BindenError(413, { code: "zstd_frames" });
    }
    this.#data = magic === ZSTD_MAGIC;
    this.#declared = null;
  }

  /**
   * The rest of the header of a frame: `Window_Descriptor` (unless it is a
   * single segment) and `Dictionary_ID`, then `Frame_Content_Size` (one byte
   * for a single segment of flag `0`, none for another frame of flag `0`)
   */
  #descriptor(): void {
    const descriptor = this.#field.readUInt8(0);
    const single = (descriptor & 0x20) !== 0;
    const dictionary = descriptor & 0x03;
    const content = descriptor >>> 6;
    this.#checksum = (descriptor & 0x04) !== 0;
    this.#fcs = content === 0 ? Number(single) : 1 << content;
    this.#to("header", (single ? 0 : 1) + (dictionary === 3 ? 4 : dictionary));
  }

  /**
   * The declared content size of the frame (RFC 8878, section 3.1.1.1.4),
   * read exactly: 8 bytes as a `bigint`, 2 bytes with an offset of 256
   */
  #size(): void {
    const size = this.#fcs;
    if (size === 8) {
      this.#declared = this.#field.readBigUInt64LE(0);
    } else if (size > 0) {
      const value = this.#field.readUIntLE(0, size);
      this.#declared = BigInt(size === 2 ? value + 256 : value);
    }
  }

  /**
   * The content of a block: the byte that an RLE block repeats (the decoder
   * refuses a block of the reserved type)
   */
  #block(): void {
    const header = this.#field.readUIntLE(0, 3);
    const rle = ((header >>> 1) & 0x03) === 1;
    this.#last = (header & 0x01) === 1;
    this.#to("content", rle ? 1 : header >>> 3);
  }

  #to(part: IZstdPart, need: number): void {
    this.#part = part;
    this.#need = need;
    this.#have = 0;
  }
}

/**
 * Decodes `zstd` data, one frame after the other, through a decoder of
 * Node.js for each data frame. The frames are read first (see `ZstdFrames`):
 * a chunk is given to the decoders only once it is known to be valid and
 * within the frames of the request, and each decoder gets the bytes of its
 * frame only (the decoder of Node.js 24 stops at the end of the first frame
 * of what it gets, and accepts a truncated one). Once a decoder has ended,
 * what it has produced is checked against the content size that its frame
 * declares (a frame that produces more fails at once), before the next
 * frame is decoded. Concatenated frames are one content (skippable frames are
 * skipped); no data at all, what is not a frame, what ends within one and a
 * frame whose content is not of its declared size fail it.
 */
export class ZstdDecoding extends Duplex {
  readonly #frames: ZstdFrames;
  /** The decoder of the frame being decoded, and what it has produced */
  #decoder: ZstdDecompress | null = null;
  #produced = 0;
  /** The declared content size of the frame being decoded, once known */
  #declared: bigint | null = null;
  #consumed = 0;

  /** A decoding whose frames count in `count` (shared by the codings of a request) */
  public constructor(count: IZstdFrameCount) {
    super({
      write: (chunk: Buffer, _encoding, callback): void => {
        this.#write(chunk, callback);
      },
      final: (callback): void => {
        this.#final(callback);
      },
      read: (): void => {
        this.#decoder?.resume();
      },
      destroy: (error, callback): void => {
        this.#decoder?.destroy();
        callback(error);
      },
    });
    this.#frames = new ZstdFrames(count);
  }

  /** The bytes that it has consumed: all of those that it has got */
  public get bytesWritten(): number {
    return this.#consumed;
  }

  #write(chunk: Buffer, callback: (error?: Error | null) => void): void {
    this.#consumed += chunk.byteLength;
    const pieces = this.#scan(chunk, callback);
    if (pieces !== null) {
      this.#feed(pieces, 0, callback);
    }
  }

  /**
   * The pieces of a chunk, read whole before a decoder gets any of it: `null`
   * once `callback` has got why it is refused
   */
  #scan(
    chunk: Buffer,
    callback: (error?: Error | null) => void,
  ): IZstdPiece[] | null {
    try {
      return this.#frames.scan(chunk);
    } catch (error: unknown) {
      callback(error as Error);
      return null;
    }
  }

  /**
   * Gives pieces to the decoders in order, each once the decoder has taken
   * the previous ones (its backpressure) and the decoder of the previous
   * frame has ended, then calls `callback`
   */
  #feed(
    pieces: readonly IZstdPiece[],
    from: number,
    callback: (error?: Error | null) => void,
  ): void {
    for (let index = from; index < pieces.length; index += 1) {
      const { bytes, start, end, declared } = pieces[index];
      const decoder = start ? this.#start() : (this.#decoder as ZstdDecompress);
      this.#declared = declared;
      const next = (): void => {
        this.#feed(pieces, index + 1, callback);
      };
      if (end) {
        decoder.once("end", () => {
          if (declared !== null && BigInt(this.#produced) !== declared) {
            callback(new Error(ZSTD_SIZE));
            return;
          }
          this.#decoder = null;
          next();
        });
        decoder.end(bytes);
        return;
      } else if (!decoder.write(bytes)) {
        decoder.once("drain", next);
        return;
      }
    }
    callback();
  }

  /** A decoder for a data frame (its magic number has been read) */
  #start(): ZstdDecompress {
    const decoder = createZstdDecompress({
      params: { [constants.ZSTD_d_windowLogMax]: ZSTD_WINDOW_LOG_MAX },
    });
    this.#decoder = decoder;
    this.#produced = 0;
    decoder
      .on("data", (chunk: Buffer) => {
        this.#produced += chunk.byteLength;
        if (
          this.#declared !== null &&
          BigInt(this.#produced) > this.#declared
        ) {
          this.destroy(new Error(ZSTD_SIZE));
        } else if (!this.push(chunk)) {
          decoder.pause();
        }
      })
      .once("error", (error: Error) => {
        this.destroy(error);
      });
    decoder.write(ZSTD_MAGIC_BYTES);
    return decoder;
  }

  #final(callback: (error?: Error | null) => void): void {
    if (this.#consumed === 0 || !this.#frames.complete) {
      callback(new Error(ZSTD_TRUNCATED));
      return;
    }
    this.push(null);
    callback();
  }
}
