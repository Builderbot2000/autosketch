/**
 * The OTLP/HTTP JSON log receiver (docs/design/13-live-world.md, *Backlog* B3). Claude Code's
 * OpenTelemetry exporter posts `ExportLogsServiceRequest` batches to `/v1/logs` on the viewer's
 * port; each log record is appended to the event log unchanged as an `otel` event, so the live
 * viewer and replay read the same thing. The token totals and per-action labels are worked out by
 * the viewer from those events (viewer/js/model.js, `Spend`), with Claude Code's own event names
 * and attributes and no schema of ours on top.
 *
 * Only the envelope is checked here (`resourceLogs[].scopeLogs[].logRecords[]`); records are not
 * interpreted. The MCP never sees model tokens otherwise (`12`, *Metrics and evals*), and no tool
 * reads any of this.
 */

/** Batches past this size are refused (413). Claude Code's batches are a few KB. */
export const MAX_OTLP_BYTES = 16 * 1024 * 1024;

/** The log records of an OTLP/HTTP JSON logs request, in batch order, or undefined when it isn't one. */
export function otlpRecords(body: unknown): Record<string, unknown>[] | undefined {
  const resourceLogs = (body as { resourceLogs?: unknown } | null)?.resourceLogs;
  if (!Array.isArray(resourceLogs)) return undefined;
  const out: Record<string, unknown>[] = [];
  for (const rl of resourceLogs) {
    // `instrumentationLibraryLogs` is the pre-1.0 name of `scopeLogs`.
    const scopes = (rl as { scopeLogs?: unknown; instrumentationLibraryLogs?: unknown } | null)?.scopeLogs ?? (rl as { instrumentationLibraryLogs?: unknown } | null)?.instrumentationLibraryLogs ?? [];
    if (!Array.isArray(scopes)) return undefined;
    for (const sl of scopes) {
      const records = (sl as { logRecords?: unknown } | null)?.logRecords ?? [];
      if (!Array.isArray(records)) return undefined;
      for (const r of records) if (typeof r === "object" && r !== null && !Array.isArray(r)) out.push(r as Record<string, unknown>);
    }
  }
  return out;
}

/** The environment Claude Code needs to send its log events here (13, B3, *Setup*). */
export function otelSetup(port: number | string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://localhost:${port}/v1/logs`,
    OTEL_LOG_TOOL_DETAILS: "1",
    OTEL_LOGS_EXPORT_INTERVAL: "1000",
  };
}
