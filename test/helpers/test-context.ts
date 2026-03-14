import { onTestFailed } from "vitest";

interface LogEntry {
  timestamp: number;
  subsystem: string;
  message: string;
  data?: unknown;
}

export function createTestContext(subsystem: string) {
  const logs: LogEntry[] = [];
  const subprocessOutput: Array<{ pid: number; stream: string; text: string }> = [];

  function log(message: string, data?: unknown) {
    logs.push({ timestamp: Date.now(), subsystem, message, data });
  }

  function captureSubprocess(pid: number, stdout: string, stderr: string) {
    if (stdout) subprocessOutput.push({ pid, stream: "stdout", text: stdout });
    if (stderr) subprocessOutput.push({ pid, stream: "stderr", text: stderr });
  }

  function dumpOnFailure() {
    onTestFailed(() => {
      console.log(`\n--- [${subsystem}] Test Context Dump ---`);
      if (logs.length > 0) {
        console.log("\nLogs:");
        for (const entry of logs) {
          const ts = new Date(entry.timestamp).toISOString().slice(11, 23);
          console.log(`  ${ts} [${entry.subsystem}] ${entry.message}`);
          if (entry.data) console.log(`    ${JSON.stringify(entry.data)}`);
        }
      }
      if (subprocessOutput.length > 0) {
        console.log("\nSubprocess Output:");
        for (const entry of subprocessOutput) {
          console.log(`  [pid:${entry.pid}] ${entry.stream}:`);
          for (const line of entry.text.split("\n").filter(Boolean)) {
            console.log(`    ${line}`);
          }
        }
      }
      console.log(`--- End [${subsystem}] ---\n`);
    });
  }

  return { log, captureSubprocess, dumpOnFailure };
}
