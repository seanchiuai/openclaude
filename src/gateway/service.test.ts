/**
 * Tests for the unified gateway service interface.
 *
 * - resolveGatewayService returns correct service type per platform.
 * - Returns null for unsupported platforms.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveGatewayService } from "./service.js";

const originalPlatform = process.platform;

function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

describe("resolveGatewayService", () => {
  it("returns LaunchAgent service on darwin", () => {
    setPlatform("darwin");
    const service = resolveGatewayService();
    expect(service).not.toBeNull();
    expect(service!.label).toBe("LaunchAgent");
  });

  it("returns systemd service on linux", () => {
    setPlatform("linux");
    const service = resolveGatewayService();
    expect(service).not.toBeNull();
    expect(service!.label).toBe("systemd");
  });

  it("returns null on unsupported platforms", () => {
    setPlatform("win32");
    const service = resolveGatewayService();
    expect(service).toBeNull();
  });

  it("returns null on freebsd", () => {
    setPlatform("freebsd");
    const service = resolveGatewayService();
    expect(service).toBeNull();
  });
});
