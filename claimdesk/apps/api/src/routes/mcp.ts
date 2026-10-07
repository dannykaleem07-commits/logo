// owned by gateway
/**
 * `POST|GET|DELETE /api/mcp` (docs/SUPREME-DESIGN.md §B.3, §N.6): the MCP endpoint over Streamable HTTP for agent run
 * tokens only (anyone else → 403). Stateless: per request a fresh McpServer with only the run's allowed tools and a
 * `StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`; Fastify hands the raw
 * request/response to the transport (`reply.hijack()`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { buildMcpServer } from '../agent/mcpServer.js';
import { getRunContext } from '../agent/dispatcher.js';

export function registerMcpRoutes(app: FastifyInstance, ctx: AppContext): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.agent) throw new HttpError(403, 'AGENT_ONLY', 'The MCP endpoint is for agent runs only');
    const rc = getRunContext(request.agent.runId);
    if (!rc) throw new HttpError(403, 'RUN_NOT_ACTIVE', 'This agent run is not active');
    const server = buildMcpServer(ctx, rc);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      ctx.logger.error('MCP request failed', { error: String(err), runId: rc.runId });
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
      }
    }
  };
  app.post('/mcp', handler);
  app.get('/mcp', handler);
  app.delete('/mcp', handler);
}
