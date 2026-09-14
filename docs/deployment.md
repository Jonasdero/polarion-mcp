# Deployment

## Render Deployment

- render.yaml defines a web service using Node.
- The build command runs `npm ci && npm run build:http`.
- The service starts with node build/index.js (HTTP server).
- Configure environment variables in the Render dashboard.

Required environment variables on Render:

- API_BASE_URL
- BEARER_TOKEN
- HTTP_API_KEY

Optional environment variables:

- HTTP_PORT when the platform does not provide PORT-like routing automatically.
- NODE_TLS_REJECT_UNAUTHORIZED only for trusted internal deployments with self-signed certificates.

## Other Platforms

- HTTP deployments run node build/index.js.
- MCP deployments run node build/index.js under a stdio MCP client.
- Ensure HTTP_PORT is provided by the platform or set explicitly.

## Mode-Specific Deployment Notes

- MCP stdio mode is usually not deployed as a public service. It is launched by the assistant client on demand.
- Streamable HTTP MCP mode (`node build/mcp-http-server.js`, `npm run start:mcp-http`) is the network-facing target for remote MCP clients such as Claude.ai custom connectors. It is deployed without credentials — each client sends its own Polarion PAT. Because that token travels in the request header, terminate TLS in front of it (reverse proxy / platform), bind the plaintext port to loopback with MCP_HTTP_HOST=127.0.0.1, and set MCP_ALLOWED_HOSTS for DNS-rebinding protection.
- REST HTTP mode (`node build/http-server.js`) is the network-facing target for ChatGPT Custom GPT Actions. It still uses the server-side BEARER_TOKEN.
- Tool execution always needs a Polarion token: stdio and REST HTTP mode take it from BEARER_TOKEN, the Streamable HTTP MCP transport from the request.

## read_when

- Use this guide when deploying to Render or another hosting platform.
