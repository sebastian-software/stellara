/** Schema-derived inventory for operator configuration drift checks. */
import { envSchema } from "./config.js";

/** Build-owned metadata, accepted by the schema but not set by operators. */
export const BUILD_OWNED_ENV_KEYS = ["APP_VERSION"] as const;

/** Fixed operator-controlled keys, derived from the accepted schema shape. */
export const RUNTIME_ENV_KEYS = Object.freeze(
  Object.keys(envSchema.shape)
    .filter((key) => !(BUILD_OWNED_ENV_KEYS as readonly string[]).includes(key))
    .sort(),
);
