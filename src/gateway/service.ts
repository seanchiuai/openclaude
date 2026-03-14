/**
 * Unified gateway service interface for platform-specific daemon management.
 *
 * Dispatches to LaunchAgent on macOS and systemd on Linux.
 * Adapted from OpenClaw's daemon/service.ts.
 */

export interface GatewayService {
  label: string;
  install(nodePath: string, entryPath: string): Promise<void>;
  uninstall(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  isLoaded(): Promise<boolean>;
  readPid(): Promise<number | null>;
}

export function resolveGatewayService(): GatewayService | null {
  if (process.platform === "darwin") {
    return createLaunchdService();
  }
  if (process.platform === "linux") {
    return createSystemdService();
  }
  return null;
}

function createLaunchdService(): GatewayService {
  return {
    label: "LaunchAgent",
    async install(nodePath, entryPath) {
      const mod = await import("./launchd.js");
      mod.installLaunchAgent(nodePath, entryPath);
    },
    async uninstall() {
      const mod = await import("./launchd.js");
      mod.uninstallLaunchAgent();
    },
    async stop() {
      const mod = await import("./launchd.js");
      mod.stopLaunchAgent();
    },
    async restart() {
      const mod = await import("./launchd.js");
      mod.restartLaunchAgent();
    },
    async isLoaded() {
      const mod = await import("./launchd.js");
      return mod.isLaunchAgentLoaded();
    },
    async readPid() {
      const mod = await import("./launchd.js");
      return mod.readLaunchAgentPid();
    },
  };
}

function createSystemdService(): GatewayService {
  return {
    label: "systemd",
    async install(nodePath, entryPath) {
      const mod = await import("./systemd.js");
      await mod.installSystemdService(nodePath, entryPath);
    },
    async uninstall() {
      const mod = await import("./systemd.js");
      await mod.uninstallSystemdService();
    },
    async stop() {
      const mod = await import("./systemd.js");
      await mod.stopSystemdService();
    },
    async restart() {
      const mod = await import("./systemd.js");
      await mod.restartSystemdService();
    },
    async isLoaded() {
      const mod = await import("./systemd.js");
      return mod.isSystemdServiceEnabled();
    },
    async readPid() {
      const mod = await import("./systemd.js");
      return mod.readSystemdServicePid();
    },
  };
}
