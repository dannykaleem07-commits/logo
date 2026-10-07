// owned by gateway
/**
 * The per-request MCP server (docs/SUPREME-DESIGN.md §B.3 "MCP endpoint"): a fresh `McpServer` registering only the
 * run's allowed tools (input schemas from their `zod/v4` definitions); each handler goes through `executeTool`, so the
 * subscription CLI's tool calls meet exactly the same dispatcher, policy, perimeter and routes as the API driver's.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { appVersion } from '../routes/health.js';
import type { RunContext } from './contracts.js';
import { executeTool } from './dispatcher.js';
import { getTool } from './tools/index.js';

export const MCP_SERVER_INFO = { name: 'claimdesk' } as const;

/** Build a server for one request of one run. Tools outside `rc.allowedTools` are never listed or callable. */
export function buildMcpServer(ctx: AppContext, rc: RunContext): McpServer {
  const server = new McpServer({ name: MCP_SERVER_INFO.name, version: appVersion() }, { capabilities: { tools: {} } });
  for (const name of [...rc.allowedTools].sort()) {
    const def = getTool(name);
    if (!def) continue;
    server.registerTool(
      name,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- zod/v4 schema of the tool (the SDK accepts v3 and v4)
      { title: def.title, description: def.description, inputSchema: def.input as any },
      async (args: unknown) => {
        const r = await executeTool(ctx, rc, name, args);
        return { content: [{ type: 'text' as const, text: r.content }], ...(r.ok ? {} : { isError: true }) };
      },
    );
  }
  return server;
}
