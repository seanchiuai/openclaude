import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const warningFilterKey = Symbol.for("openclaude.warning-filter");

/** Suppress noisy experimental/deprecated warnings from node:sqlite. */
function installProcessWarningFilter(): void {
  const globalState = globalThis as typeof globalThis & {
    [warningFilterKey]?: { installed: boolean };
  };
  if (globalState[warningFilterKey]?.installed) {
    return;
  }

  const originalEmitWarning = process.emitWarning.bind(process);
  const wrappedEmitWarning: typeof process.emitWarning = ((...args: unknown[]) => {
    const warning = normalizeWarningArgs(args);
    if (shouldIgnoreWarning(warning)) {
      return;
    }
    return Reflect.apply(originalEmitWarning, process, args);
  }) as typeof process.emitWarning;

  process.emitWarning = wrappedEmitWarning;
  globalState[warningFilterKey] = { installed: true };
}

function normalizeWarningArgs(args: unknown[]): {
  code?: string;
  name?: string;
  message?: string;
} {
  const warningArg = args[0];
  const secondArg = args[1];
  const thirdArg = args[2];
  let name: string | undefined;
  let code: string | undefined;
  let message: string | undefined;

  if (warningArg instanceof Error) {
    name = warningArg.name;
    message = warningArg.message;
    code = (warningArg as Error & { code?: string }).code;
  } else if (typeof warningArg === "string") {
    message = warningArg;
  }

  if (secondArg && typeof secondArg === "object" && !Array.isArray(secondArg)) {
    const options = secondArg as { type?: unknown; code?: unknown };
    if (typeof options.type === "string") {
      name = options.type;
    }
    if (typeof options.code === "string") {
      code = options.code;
    }
  } else {
    if (typeof secondArg === "string") {
      name = secondArg;
    }
    if (typeof thirdArg === "string") {
      code = thirdArg;
    }
  }

  return { name, code, message };
}

function shouldIgnoreWarning(warning: {
  code?: string;
  name?: string;
  message?: string;
}): boolean {
  if (warning.code === "DEP0040" && warning.message?.includes("punycode")) {
    return true;
  }
  if (warning.code === "DEP0060" && warning.message?.includes("util._extend")) {
    return true;
  }
  if (
    warning.name === "ExperimentalWarning" &&
    warning.message?.includes("SQLite is an experimental feature")
  ) {
    return true;
  }
  return false;
}

export function requireNodeSqlite(): typeof import("node:sqlite") {
  installProcessWarningFilter();
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`,
      { cause: err },
    );
  }
}
