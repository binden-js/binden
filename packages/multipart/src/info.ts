import { type Context, formatting } from "binden";

/** A limit of busboy on the count of the parts */
export type ILimitName = "fields" | "files" | "parts";

/**
 * What a parse has truncated or dropped (with `throw_limits: false`; with
 * `true` the request is refused instead)
 */
export interface IMultipartInfo {
  /** The names of the fields truncated to `fieldSize`, in their order */
  readonly truncated_fields: readonly string[];
  /** The limits on the count of the parts that have been reached: the parts over them are dropped */
  readonly limits_hit: readonly ILimitName[];
}

/** What a parse records while it reads the body */
export interface IParseInfo {
  /** The names of the fields truncated to `fieldSize`, in their order */
  readonly truncated_fields: string[];
  /** The limits on the count of the parts that have been reached */
  readonly limits_hit: ILimitName[];
}

/** The requests whose body has been parsed (or is being parsed) */
const infos = new WeakMap<object, IParseInfo>();

/** Records a parse of the request: `null` if it has already been parsed */
export function startParse(request: object): IParseInfo | null {
  if (infos.has(request)) {
    return null;
  }
  const info: IParseInfo = { truncated_fields: [], limits_hit: [] };
  infos.set(request, info);
  return info;
}

/**
 * What the parse of the multipart body of the request has truncated or
 * dropped, e.g. to tell the client: `null` when `Multipart` has not parsed it
 * (e.g. another media type)
 */
export function multipartInfo(context: Context): IMultipartInfo | null {
  // What reading the context throws is formatted (see `formatting()`)
  const info = formatting(() => infos.get(context.request));
  if (typeof info === "undefined") {
    return null;
  }
  return Object.freeze({
    truncated_fields: Object.freeze([...info.truncated_fields]),
    limits_hit: Object.freeze([...info.limits_hit]),
  });
}
