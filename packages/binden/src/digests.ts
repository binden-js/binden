/**
 * The digest of the content of a message (RFC 9530, section 2): of the bytes
 * that it sends. A reply without the body of the application (e.g. to
 * `HEAD`, or a `304`), or with a part of it (a `206`), does not have it.
 */
export const contentDigests: readonly string[] = ["Content-Digest"];

/**
 * The digests of the selected representation (`Repr-Digest` of RFC 9530,
 * section 3, and `Digest` of RFC 3230): still those of a `HEAD`, a `304` or a
 * `206` (appendix B.2), but not of a reply that replaces the representation
 * (e.g. a `412`)
 */
export const representationDigests: readonly string[] = [
  "Digest",
  "Repr-Digest",
];
