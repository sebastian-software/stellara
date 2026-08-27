/**
 * oxlint configuration sourced from `eslint-config-setup`, so oxlint and
 * ESLint share the same `node`/`react`/`ai` flags as a single source of truth.
 *
 * Requires Node.js >= 20.19 (we run on 24); oxlint loads the file via Node
 * dynamic import.
 */
import { getOxlintConfig } from "eslint-config-setup";

export default getOxlintConfig({ node: true });
