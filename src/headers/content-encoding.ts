import AcceptEncoding from "./accept-encoding.js";

export type IEncodings = "br" | "compress" | "deflate" | "gzip" | "x-gzip";

export interface IContentEncoding {
  encoding: IEncodings;
}

export class ContentEncoding
  extends AcceptEncoding
  implements IContentEncoding
{
  public constructor({ encoding }: IContentEncoding) {
    super({ encoding });
  }

  public get encoding(): IEncodings {
    return super.encoding as IEncodings;
  }

  public static fromString(input?: string): ContentEncoding[] {
    if (typeof input === "undefined") {
      return [];
    }

    const encodings = ["gzip", "x-gzip", "compress", "deflate", "br"];

    return input
      .split(",")
      .map((e) => e.trim())
      .filter((e): e is IEncodings => encodings.includes(e))
      .map((encoding) => new ContentEncoding({ encoding }))
      .reverse();
  }
}

export default ContentEncoding;
