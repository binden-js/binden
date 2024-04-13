import config from "eslint-config-binden-ts";
export default [
  ...config,
  {
    rules: { "@typescript-eslint/no-floating-promises": "off" },
    files: ["**/*.test.ts"],
  },
  { languageOptions: { parserOptions: { project: "tsconfig.json" } } },
];
