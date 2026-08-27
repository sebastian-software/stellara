// Flat config powered by `eslint-config-setup`.
// Profile: TypeScript + Node (no React, no AI guardrails) with the `oxlint`
// flag enabled so that ESLint skips rules already handled by oxlint.
//
// Markdown sources are ignored: eslint-config-setup's typed-linting profile
// applies type-aware TypeScript rules globally, and the MDX parser cannot
// satisfy them. JSON files are intentionally NOT ignored so that
// `eslint-plugin-package-json` (bundled with `eslint-config-setup`) can lint
// `package.json`. The override block below disables every rule from the
// upstream `eslint-config-setup/base` block for JSON files, because those
// rules are written against the JavaScript/TypeScript AST and would crash
// when evaluated against the JSON parser. The dedicated JSON blocks from
// `eslint-config-setup` (`json`, `jsonc`, `package-json`) still apply.
import { getEslintConfig } from "eslint-config-setup";

const config = await getEslintConfig({ node: true, oxlint: true });

// Build the disable map dynamically from the upstream base block so the
// list stays in sync when `eslint-config-setup` adds or removes rules.
const baseBlock = config.find((block) => block.name === "eslint-config-setup/base");
if (!baseBlock?.rules) {
  throw new Error("eslint-config-setup/base block not found — cannot build JSON override");
}
const baseRulesDisabledForJson = Object.fromEntries(
  Object.keys(baseBlock.rules).map((ruleName) => [ruleName, "off"]),
);

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      ".claude/**",
      ".sf-plugin/**",
      "docs/**",
      "**/*.md",
      "pnpm-lock.yaml",
    ],
  },
  ...config,
  // Disable every rule from the upstream `eslint-config-setup/base` block
  // for JSON files. Those rules target the JavaScript/TypeScript AST and
  // would either misfire or throw against the JSON parser. The JSON-specific
  // blocks (`eslint-config-setup/json`, `.../jsonc`, `.../package-json`)
  // remain active.
  {
    name: "stellara/json-disable-base-rules",
    files: ["**/*.json"],
    rules: baseRulesDisabledForJson,
  },
];
