/**
 * Streamable HTTP MCP server for the Polarion REST API.
 *
 * Unlike `http-server.ts` (a plain REST wrapper for ChatGPT Custom GPT Actions),
 * this server speaks the real MCP **Streamable HTTP** transport. That is the
 * transport remote MCP clients use — including Claude.ai custom connectors — so
 * you can add `https://your-host/mcp` as a connector URL.
 *
 * Security:
 * - The deployment holds **no Polarion credentials**. Every `/mcp` request must
 *   send the caller's own Polarion Personal Access Token as
 *   `Authorization: Bearer <polarion-pat>`; that token is used verbatim for the
 *   upstream REST calls of that request, so Polarion itself authenticates and
 *   authorizes every action under the real user.
 * - Requests without a Bearer token are rejected with 401. An invalid token is
 *   rejected by Polarion (401/403 surfaced back to the client).
 * - Only `API_BASE_URL` is configured server-side.
 * - Optionally enable DNS-rebinding protection by setting `MCP_ALLOWED_HOSTS`.
 *
 * Sessions are stateful: each MCP `initialize` creates a transport (with its own
 * server instance) keyed by an `mcp-session-id` that the client echoes back on
 * subsequent requests.
 */

import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import express, { type Request, type Response, type NextFunction } from 'express';
import dotenv from 'dotenv';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { SERVER_NAME, SERVER_VERSION, API_BASE_URL, requestBearerToken } from './config.js';
import { createPolarionServer } from './server.js';

dotenv.config();

const MCP_PATH = '/mcp';

/**
 * Options for {@link createMcpHttpApp}.
 */
export interface McpHttpAppOptions {
  /** Optional allow-list of Host header values enabling DNS-rebinding protection. */
  allowedHosts?: string[];
}

/**
 * Returns a JSON-RPC error body for transport-level failures.
 *
 * @param message - Human-readable error message.
 * @returns A JSON-RPC 2.0 error envelope with a null id.
 */
function jsonRpcError(message: string) {
  return { jsonrpc: '2.0' as const, error: { code: -32000, message }, id: null };
}

/**
 * Builds the Express application that serves the MCP Streamable HTTP transport.
 *
 * The returned object exposes the app plus a `closeAllSessions` helper so callers
 * (and tests) can shut active transports down cleanly.
 *
 * @param options - Bearer token and optional DNS-rebinding allow-list.
 * @returns The configured app and a session-cleanup function.
 */
export function createMcpHttpApp(options: McpHttpAppOptions = {}): {
  app: express.Express;
  closeAllSessions: () => Promise<void>;
} {
  const { allowedHosts } = options;
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Active transports keyed by MCP session id.
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  /**
   * Takes the caller's Polarion Personal Access Token from the `Authorization`
   * header and makes it the token for everything this request triggers.
   *
   * The server keeps no credentials of its own, so a missing or malformed
   * header is the only thing rejected here; whether the token is *valid* is
   * Polarion's decision on the upstream call.
   *
   * @param req - Incoming request.
   * @param res - Outgoing response.
   * @param next - Next middleware in the chain.
   * @returns Nothing; either runs the chain with the token bound or sends a 401.
   */
  const requireBearer = (req: Request, res: Response, next: NextFunction): void => {
    const header = req.get('authorization') ?? '';
    const [scheme, ...rest] = header.split(' ');
    const value = rest.join(' ').trim();
    if (scheme !== 'Bearer' || !value) {
      res.status(401).json(jsonRpcError('Unauthorized: send your Polarion Personal Access Token as "Authorization: Bearer <token>"'));
      return;
    }
    requestBearerToken.run(value, next);
  };

  // Health check (no auth) for load balancers and quick verification.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      server: SERVER_NAME,
      version: SERVER_VERSION,
      transport: 'streamable-http',
      apiBaseUrl: API_BASE_URL,
      activeSessions: Object.keys(transports).length,
    });
  });

  /**
   * Handles MCP requests on an existing session (GET for the SSE stream, DELETE
   * to terminate the session).
   *
   * @param req - Incoming request carrying the `mcp-session-id` header.
   * @param res - Outgoing response.
   * @returns A promise that resolves once the transport has handled the request.
   */
  const handleSessionRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.header('mcp-session-id');
    if (!sessionId || !transports[sessionId]) {
      res.status(400).json(jsonRpcError('Invalid or missing session ID'));
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };

  // POST: initialize a new session, or dispatch into an existing one.
  app.post(MCP_PATH, requireBearer, async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
        ...(allowedHosts && allowedHosts.length > 0
          ? { enableDnsRebindingProtection: true, allowedHosts }
          : {}),
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
        }
      };

      const server = createPolarionServer();
      await server.connect(transport);
    } else {
      res.status(400).json(jsonRpcError('Bad Request: no valid session ID provided'));
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  app.get(MCP_PATH, requireBearer, handleSessionRequest);
  app.delete(MCP_PATH, requireBearer, handleSessionRequest);

  /**
   * Closes every active transport. Used on shutdown and by tests.
   *
   * @returns A promise that resolves once all transports are closed.
   */
  const closeAllSessions = async (): Promise<void> => {
    await Promise.all(Object.values(transports).map(t => t.close().catch(() => undefined)));
  };

  return { app, closeAllSessions };
}

/**
 * Starts the Streamable HTTP MCP server using environment configuration.
 *
 * Required env: `API_BASE_URL`. Optional: `MCP_HTTP_PORT` (or `HTTP_PORT`),
 * `MCP_ALLOWED_HOSTS` (comma-separated). No credentials are read here — each
 * client sends its own Polarion PAT.
 *
 * @returns The underlying Node HTTP server once it is listening.
 */
export function startMcpHttpServer(): HttpServer {
  const port = Number(process.env.MCP_HTTP_PORT || process.env.HTTP_PORT || 3000);
  const allowedHosts = (process.env.MCP_ALLOWED_HOSTS || '')
    .split(',')
    .map(h => h.trim())
    .filter(Boolean);

  const { app, closeAllSessions } = createMcpHttpApp({ allowedHosts });

  // Behind a TLS reverse proxy, set MCP_HTTP_HOST=127.0.0.1 so the plaintext
  // port — over which clients send their Polarion PAT — is never public.
  const host = process.env.MCP_HTTP_HOST || '0.0.0.0';

  const httpServer = app.listen(port, host, () => {
    console.log(`[INFO] ${SERVER_NAME} MCP Streamable HTTP server ${SERVER_VERSION} listening on port ${port}`);
    console.log(`[INFO] MCP endpoint: http://localhost:${port}${MCP_PATH} (send your Polarion PAT as Bearer token)`);
    console.log(`[INFO] Health:       http://localhost:${port}/health`);
    console.log(`[INFO] Proxying Polarion API at ${API_BASE_URL}`);
    if (allowedHosts.length === 0) {
      console.log('[WARN] DNS-rebinding protection is OFF. Set MCP_ALLOWED_HOSTS to enable it.');
    }
  });

  const shutdown = () => {
    console.log('\n[INFO] Shutting down MCP Streamable HTTP server...');
    void closeAllSessions().finally(() => {
      httpServer.close(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return httpServer;
}

// Auto-start when executed directly (node build/mcp-http-server.js), but not when imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startMcpHttpServer();
}
