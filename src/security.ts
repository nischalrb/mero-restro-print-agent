import { Request, Response, NextFunction } from "express";
import { isAllowedOrigin } from "./config";
import { logger } from "./logger";

/**
 * Two independent layers, deliberately not just one:
 *
 * 1. Origin allowlist (this file's `originGuard`) — rejects the request
 *    SERVER-SIDE if its Origin header isn't exactly one of
 *    ALLOWED_ORIGINS. This is the one that actually matters: permissive
 *    CORS *response* headers (Access-Control-Allow-Origin: *) only stop
 *    a browser from letting its JS *read* the response — the request
 *    still reaches this process and still runs. A malicious page on any
 *    other site trying `fetch('http://127.0.0.1:38111/print', {method:
 *    'POST', body: ...})` gets rejected here before any printer is
 *    touched, regardless of what CORS headers we'd otherwise send back.
 * 2. Pairing token (`requireToken`) — a second factor so that even a
 *    request that somehow gets the Origin header right (e.g. a
 *    non-browser process on the same machine, which can set any Origin
 *    header it likes) still can't print without the token the user
 *    copy-pasted from Settings > Printers during setup.
 *
 * /health and /printers (read-only, no physical action) skip the token
 * check so the frontend's discovery probe doesn't need it up front — only
 * routes that can trigger a physical print (/print, /test-print) require
 * it.
 */
export function originGuard(extraAllowedOrigins: string[] = []) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;

    // No Origin header at all (e.g. curl, same-machine health check tooling)
    // — allowed through only for read-only GETs; write routes still require
    // the pairing token regardless, so this isn't a bypass.
    if (!origin) {
      next();
      return;
    }

    if (!isAllowedOrigin(origin, extraAllowedOrigins)) {
      logger.warn(`Rejected request from untrusted origin: ${origin} (${req.method} ${req.path})`);
      res.status(403).json({ success: false, message: "This origin is not permitted to use the Print Agent." });
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Print-Agent-Token");

    // Chrome's Private Network Access (PNA) check: a page loaded from
    // anywhere that ISN'T itself loopback — the deployed
    // https://app.merorestroapp.com, or even a dev server reachable at a
    // LAN IP — fetching a loopback address like 127.0.0.1 is treated as a
    // "public/private → local" request. Chrome forces a preflight OPTIONS
    // for it (even for what would otherwise be a plain unauthenticated GET
    // like /health) carrying `Access-Control-Request-Private-Network: true`,
    // and silently fails the real request with no readable response unless
    // this header is echoed back on that preflight. Without this, every
    // request from the production app (or any non-localhost dev origin) to
    // this agent fails before it ever reaches a route handler — this is
    // almost certainly why /health looked unreachable.
    // See https://developer.chrome.com/blog/private-network-access-preflight
    if (req.headers["access-control-request-private-network"] === "true") {
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };
}

export function requireToken(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const provided = req.header("X-Print-Agent-Token");

    if (!provided || provided !== expectedToken) {
      logger.warn(`Rejected ${req.method} ${req.path} — missing or incorrect pairing token.`);
      res.status(401).json({
        success: false,
        message: "Print Agent pairing token missing or incorrect. Reconnect the printer agent from Settings > Printers.",
      });
      return;
    }

    next();
  };
}
