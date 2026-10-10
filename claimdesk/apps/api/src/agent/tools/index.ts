/**
 * Tool registry (docs/SUPREME-DESIGN.md §B.3, §P.2) — owned by `foundation`. Each slice fills its own array in its own
 * file; this module only concatenates them, so no slice edits a shared registration file.
 */
import type { HttpMethod, ToolDef, ToolName } from '../contracts.js';
import { coreTools } from './core.js';
import { needsYouTools } from './needsYou.js';
import { mailTools } from './mail.js';
import { intakeTools } from './intake.js';
import { caseworkTools } from './casework.js';
// Autopilot (docs/SUPREME-AUTOPILOT.md §H.2): stubs by ap-foundation, filled by each owning slice.
import { autopilotTools } from './autopilot.js';
import { bookingTools } from './booking.js';
import { clashTools } from './clash.js';
import { signingTools } from './signing.js';
// Knowledge Builder (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.2): stubs by knowledge-core, filled by each owning slice.
import { knowledgeLearningTools } from './knowledgeLearning.js';
import { knowledgeResearchTools } from './knowledgeResearch.js';
import { knowledgeUseTools } from './knowledgeUse.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
type AnyToolDef = ToolDef<any, any>;

/** Tools registered at runtime (tests register a fixture tool here). */
const extraTools: AnyToolDef[] = [];

/** Every registered tool (slice arrays + runtime registrations). */
export function allTools(): AnyToolDef[] {
  return [...coreTools, ...needsYouTools, ...mailTools, ...intakeTools, ...caseworkTools, ...autopilotTools, ...bookingTools, ...clashTools, ...signingTools, ...knowledgeLearningTools, ...knowledgeResearchTools, ...knowledgeUseTools, ...extraTools];
}

export function getTool(name: ToolName): AnyToolDef | undefined {
  return allTools().find((t) => t.name === name);
}

/** Register a tool at runtime; returns a function that removes it again. Names must be unique. */
export function registerTool(def: AnyToolDef): () => void {
  if (getTool(def.name)) throw new Error(`Tool ${def.name} is already registered`);
  extraTools.push(def);
  return () => {
    const i = extraTools.indexOf(def);
    if (i >= 0) extraTools.splice(i, 1);
  };
}

/** The MCP endpoint: reachable by every agent principal (§B.2 rule 1). */
export const MCP_ROUTE_PATTERNS: readonly string[] = ['/api/mcp'];

/**
 * The perimeter's route allow-list (§B.2 rule 1): `METHOD /api<pattern>` for every HTTP tool's declared route, plus the
 * MCP endpoint for every method it serves.
 */
export function agentRouteAllowlist(): Set<string> {
  const out = new Set<string>();
  for (const pattern of MCP_ROUTE_PATTERNS) for (const m of ['GET', 'POST', 'DELETE']) out.add(`${m} ${pattern}`);
  for (const t of allTools()) {
    if (!t.http || !t.httpRoute) continue;
    const routes = Array.isArray(t.httpRoute) ? t.httpRoute : [t.httpRoute];
    for (const r of routes) out.add(routeKey(r.method, r.pattern));
  }
  return out;
}

/** `METHOD /api/...` key for a route pattern relative to /api (or already absolute). */
export function routeKey(method: HttpMethod | string, pattern: string): string {
  const p = pattern.startsWith('/api/') || pattern === '/api' ? pattern : `/api${pattern.startsWith('/') ? '' : '/'}${pattern}`;
  return `${method.toUpperCase()} ${p}`;
}
