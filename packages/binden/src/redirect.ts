import { formatStack } from "./exchange.js";
/** The status codes of a redirect */
export type IRedirectStatus = 301 | 302 | 303 | 307 | 308;

/** The options of `BindenResponse.redirect()` */
export interface IRedirectOptions {
  /**
   * Allow a location on another origin, or a network-path reference (`//host`):
   * `false` by default, so that a location taken from the request cannot send
   * the client to another site (an open redirect)
   */
  readonly allow_external?: boolean | undefined;
}

const statuses: ReadonlySet<unknown> = new Set([301, 302, 303, 307, 308]);

/** Whether a value is the status code of a redirect */
export function isRedirectStatus(status: unknown): status is IRedirectStatus {
  return statuses.has(status);
}

/** A scheme (RFC 3986, section 3.1) */
const scheme = /^[a-z][\d+.a-z-]*:/iu;

/** Characters that a location never has: controls, whitespace and backslashes */
const forbidden = /[\p{Cc}\s\\]/u;

/**
 * The `Location` of a redirect: the WHATWG URL serialization of `location`,
 * resolved against the URL of the request (`base`). A relative reference stays
 * relative (its path, query and fragment). Locations on other origins than
 * `origin` (`null` when it is not known) and network-path references need
 * `allow_external`; userinfo, controls, whitespace, backslashes and schemes
 * other than `http` and `https` throw a `TypeError`.
 */
export function redirectLocation(
  location: URL | string,
  base: URL,
  origin: string | null,
  allow_external: boolean,
): string {
  const input = location instanceof URL ? location.href : location;
  if (typeof input !== "string" || input === "") {
    throw formatStack(
      new TypeError("The location is not a non-empty string or a URL"),
    );
  } else if (forbidden.test(input)) {
    throw formatStack(
      new TypeError(
        "The location has a control character, whitespace or a backslash",
      ),
    );
  }

  const absolute = scheme.test(input);
  const network = !absolute && input.startsWith("//");
  // An `@` in the authority of an absolute URL or a network-path reference,
  // which the URL parser may find after any number of slashes (also an empty
  // userinfo, which its serialization would drop). A relative reference has
  // the authority of the request, which has none.
  const userinfo =
    (absolute || network) &&
    /^[^/?#]*@/u.test(input.replace(scheme, "").replace(/^\/+/u, ""));
  const url = new URL(input, base);

  if (userinfo) {
    throw formatStack(new TypeError("The location has userinfo"));
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw formatStack(
      new TypeError(`The location has the scheme ${url.protocol}`),
    );
  } else if (
    !allow_external &&
    (network || (absolute && url.origin !== origin))
  ) {
    throw formatStack(
      new TypeError(
        "The location is external: set `allow_external` to allow it",
      ),
    );
  }

  if (absolute) {
    return url.href;
  } else if (network) {
    return url.href.slice(url.protocol.length);
  }
  // A path that starts with `//` would be read as an authority (WHATWG URL,
  // section 4.5): `/.` keeps it a path
  const path = url.pathname.startsWith("//")
    ? `/.${url.pathname}`
    : url.pathname;
  return `${path}${url.search}${url.hash}`;
}
