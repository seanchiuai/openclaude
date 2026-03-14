import { describe, it, expect, afterEach } from "vitest";
import {
  emitHeartbeatEvent,
  onHeartbeatEvent,
  getLastHeartbeatEvent,
  resolveIndicatorType,
  type HeartbeatEventPayload,
} from "./heartbeat-events.js";

describe("heartbeat-events", () => {
  afterEach(() => {
    // No reset needed — listeners are cleaned up per test via unsubscribe
  });

  it("emits events to registered listeners", () => {
    const received: HeartbeatEventPayload[] = [];
    const unsub = onHeartbeatEvent((evt) => received.push(evt));

    emitHeartbeatEvent({ status: "sent", reason: "test" });

    expect(received).toHaveLength(1);
    expect(received[0].status).toBe("sent");
    expect(received[0].ts).toBeGreaterThan(0);

    unsub();
  });

  it("unsubscribe prevents further events", () => {
    const received: HeartbeatEventPayload[] = [];
    const unsub = onHeartbeatEvent((evt) => received.push(evt));

    emitHeartbeatEvent({ status: "sent" });
    unsub();
    emitHeartbeatEvent({ status: "failed" });

    expect(received).toHaveLength(1);
  });

  it("getLastHeartbeatEvent returns the most recent event", () => {
    const unsub = onHeartbeatEvent(() => {});

    emitHeartbeatEvent({ status: "ok-token" });
    emitHeartbeatEvent({ status: "sent", reason: "latest" });

    const last = getLastHeartbeatEvent();
    expect(last?.status).toBe("sent");
    expect(last?.reason).toBe("latest");

    unsub();
  });

  it("resolveIndicatorType maps statuses correctly", () => {
    expect(resolveIndicatorType("ok-empty")).toBe("ok");
    expect(resolveIndicatorType("ok-token")).toBe("ok");
    expect(resolveIndicatorType("sent")).toBe("alert");
    expect(resolveIndicatorType("failed")).toBe("error");
    expect(resolveIndicatorType("skipped")).toBeUndefined();
  });

  it("tolerates listener errors without breaking emission", () => {
    const received: HeartbeatEventPayload[] = [];
    const unsub1 = onHeartbeatEvent(() => {
      throw new Error("boom");
    });
    const unsub2 = onHeartbeatEvent((evt) => received.push(evt));

    emitHeartbeatEvent({ status: "sent" });

    expect(received).toHaveLength(1);

    unsub1();
    unsub2();
  });
});
