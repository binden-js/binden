// The bare imports of a packed package (its `dist/**/*.js` and `*.d.ts`), which
// must be declared by its `package.json`: an import that resolves in this
// repository only because a package is hoisted fails for a consumer. A module is
// allowed when it is a `node:` builtin, the package itself, or a dependency
// (`dependencies`, `peerDependencies`, `optionalDependencies`); a declaration file
// may also import the types of a dependency from its `@types/` package.

/** The module specifiers of a module or a declaration file */
export function importsOf(source) {
  const specifiers = new Set();
  const patterns = [
    // import x from "m"; import { x } from "m"; export * from "m"; export { x } from "m"
    /^\s*(?:import|export)\s(?:[^"'`;]*?\sfrom\s)?["'](?<specifier>[^"']+)["']/gmu,
    // import("m"), also as a type in a declaration file
    /\bimport\(\s*["'](?<specifier>[^"']+)["']\s*\)/gu,
    // /// <reference types="m" />
    /^\/\/\/\s*<reference\s+types=["'](?<specifier>[^"']+)["']/gmu,
  ];
  for (const pattern of patterns) {
    for (const { groups } of source.matchAll(pattern)) {
      specifiers.add(groups.specifier);
    }
  }
  return [...specifiers];
}

/**
 * The package of a bare specifier (`@scope/name` or `name`), or `null` for a
 * relative or absolute one
 */
export function packageOf(specifier) {
  if (/^(?:\.{1,2}\/|\/|[a-z][a-z\d+.-]*:)/iu.test(specifier)) {
    return specifier.startsWith("node:") ? "node:" : null;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The `@types/` package of a package (`@scope/name` → `@types/scope__name`) */
export function typesOf(name) {
  return `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
}

/**
 * The undeclared imports of a package: `files` maps the paths of its archive to
 * their content (see `readTarball()`), `manifest` is its `package.json`
 */
export function undeclaredImports(manifest, files) {
  const declared = new Set([
    manifest.name,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  const allowed = (name, declaration) =>
    name === null ||
    name === "node:" ||
    declared.has(name) ||
    (declaration && declared.has(typesOf(name)));
  const errors = [];
  for (const [path, content] of files) {
    const declaration = /\.d\.[cm]?ts$/u.test(path);
    if (path.startsWith("dist/") && (declaration || /\.[cm]?js$/u.test(path))) {
      for (const specifier of importsOf(content.toString("utf8"))) {
        if (!allowed(packageOf(specifier), declaration)) {
          errors.push(
            `${manifest.name}: ${path} imports ${specifier}, which is not declared`,
          );
        }
      }
    }
  }
  return errors;
}
