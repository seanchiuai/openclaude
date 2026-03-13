/**
 * Environment variable substitution for config values.
 * Extracted from OpenClaw's config/env-substitution.ts.
 *
 * Replaces $VAR_NAME or ${VAR_NAME} patterns with process.env values.
 */

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

export function substituteEnvVars(value: string): string {
  return value.replace(ENV_PATTERN, (_match, braced: string, bare: string) => {
    const name = braced ?? bare;
    const envValue = process.env[name];
    if (envValue === undefined) {
      throw new Error(`Environment variable ${name} is not set`);
    }
    return envValue;
  });
}

export function substituteEnvVarsDeep(obj: unknown): unknown {
  if (typeof obj === "string") {
    // Only substitute if the string contains $ references
    if (obj.includes("$")) {
      return substituteEnvVars(obj);
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVarsDeep);
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVarsDeep(value);
    }
    return result;
  }

  return obj;
}
