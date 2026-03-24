import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { bus } from "../utils/event-bus.js";
import { createChildLogger } from "../utils/logger.js";
import { RISK_PROFILES } from "../decisions/risk-gate.js";
import { SIGNAL_PROFILES } from "../decisions/signal-gate.js";

const log = createChildLogger("control-api");

/**
 * Control API — HTTP REST endpoint for dashboard commands.
 *
 * This is how the frontend controls the engine.
 * All state changes go through this API.
 *
 * Endpoints:
 *   GET  /api/status           — engine state snapshot
 *   GET  /api/profiles         — available risk/signal profiles
 *   POST /api/kill-switch      — emergency stop
 *   POST /api/config           — update runtime config
 *   GET  /api/journal          — recent trade journal entries
 *   GET  /api/features/:symbol — latest features for a symbol
 */

interface EngineControl {
  getStatus: () => Record<string, unknown>;
  setRiskProfile: (name: string) => void;
  setSignalProfile: (name: string) => void;
  toggleStrategy: (name: string, enabled: boolean) => void;
  getStrategies: () => Array<{ name: string; enabled: boolean }>;
  getJournal: (limit: number) => unknown[];
  getActiveSymbols: () => string[];
}

export function startControlApi(port: number, control: EngineControl): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    try {
      // GET /api/status
      if (method === "GET" && url === "/api/status") {
        json(res, control.getStatus());
        return;
      }

      // GET /api/profiles
      if (method === "GET" && url === "/api/profiles") {
        json(res, {
          risk: Object.keys(RISK_PROFILES),
          signal: Object.keys(SIGNAL_PROFILES),
          riskDetails: RISK_PROFILES,
          signalDetails: SIGNAL_PROFILES,
        });
        return;
      }

      // GET /api/strategies
      if (method === "GET" && url === "/api/strategies") {
        json(res, control.getStrategies());
        return;
      }

      // POST /api/kill-switch
      if (method === "POST" && url === "/api/kill-switch") {
        bus.emit("risk:kill_switch", { reason: "Control API kill switch", ts: Date.now() });
        json(res, { ok: true, message: "Kill switch activated" });
        return;
      }

      // POST /api/config
      if (method === "POST" && url === "/api/config") {
        const body = await readBody(req);
        const config = JSON.parse(body);

        if (config.riskProfile) {
          control.setRiskProfile(config.riskProfile);
          log.info({ profile: config.riskProfile }, "Risk profile changed via API");
        }

        if (config.signalProfile) {
          control.setSignalProfile(config.signalProfile);
          log.info({ profile: config.signalProfile }, "Signal profile changed via API");
        }

        if (config.toggleStrategy) {
          const { name, enabled } = config.toggleStrategy;
          control.toggleStrategy(name, enabled);
          log.info({ strategy: name, enabled }, "Strategy toggled via API");
        }

        json(res, { ok: true });
        return;
      }

      // GET /api/journal?limit=50
      if (method === "GET" && url.startsWith("/api/journal")) {
        const params = new URL(url, "http://localhost").searchParams;
        const limit = Number(params.get("limit") ?? "50");
        json(res, control.getJournal(limit));
        return;
      }

      // GET /api/symbols
      if (method === "GET" && url === "/api/symbols") {
        json(res, control.getActiveSymbols());
        return;
      }

      // 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.warn({ port }, "Control API port in use, skipping");
    } else {
      log.error({ err }, "Control API error");
    }
  });

  server.listen(port, () => {
    log.info({ port }, "Control API started");
  });
}

function json(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
