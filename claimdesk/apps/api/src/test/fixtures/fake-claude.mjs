#!/usr/bin/env node
/**
 * A fake `claude` (Claude Code CLI) for tests and the CI scenario run — it never calls a model.
 *
 *   fake-claude --version            → "2.1.300 (Claude Code)"
 *   fake-claude auth status          → {"loggedIn":true,"authMethod":"oauth_token"} when CLAUDE_CODE_OAUTH_TOKEN is set
 *   fake-claude -p … (prompt on stdin) → canned stream-json; with --mcp-config it calls the ClaimDesk MCP endpoint
 *                                       (initialize, tools/list, tools/call) using the bearer token from that file.
 *
 * Behaviour is chosen by markers in the prompt (stdin):
 *   [[fake:call:<tool>:<json input>]]   call that tool through MCP (repeatable)
 *   [[fake:result:<json>]]              structured_output of the success result (default {})
 *   [[fake:usage_event]]                rate_limit_event status "rejected" + an error result
 *   [[fake:api_error_limit]]            result with api_error "usage_limit_reached" + rate_limit_info.resetsAt
 *   [[fake:legacy_limit]]               result text "Claude AI usage limit reached|<epoch>"
 *   [[fake:window_limit]]               result text "5-hour limit reached ∙ resets <epoch>"
 *   [[fake:auth]]                       result "OAuth token has expired. Please run /login"
 *   [[fake:sleep]]                      sleep 60 s before answering (timeout tests)
 *   [[fake:invalid]]                    success result without structured_output
 *   [[fake:schema_retries]]             error_max_structured_output_retries
 *   [[fake:max_turns]]                  error_max_turns
 *   [[fake:mcp_down]]                   init reports the claimdesk MCP server "failed"
 *   [[fake:no_result]]                  exit 1 without a result
 *   [[fake:pdf_too_large]]              result with api_error "pdf_too_large"
 *
 * Everything it saw (argv, environment variable names, stdin, MCP responses) is written to
 * `<cwd>/fake-claude-record.json` so tests can assert on it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);

if (argv[0] === '--version') {
  process.stdout.write('2.1.300 (Claude Code)\n');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.stdout.write(JSON.stringify({ loggedIn: Boolean(token), authMethod: token ? 'oauth_token' : 'none', apiProvider: 'firstParty' }) + '\n');
  process.exit(0);
}

const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const readStdin = () =>
  new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => resolve(data));
  });

const emit = (ev) => process.stdout.write(JSON.stringify(ev) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const prompt = await readStdin();
const has = (m) => prompt.includes(`[[fake:${m}]]`);
const record = { argv, envKeys: Object.keys(process.env).sort(), env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null, DISABLE_AUTOUPDATER: process.env.DISABLE_AUTOUPDATER ?? null, MAX_MCP_OUTPUT_TOKENS: process.env.MAX_MCP_OUTPUT_TOKENS ?? null, hasOauthToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) }, stdin: prompt, cwd: process.cwd(), pid: process.pid, mcp: [] };
const saveRecord = () => writeFileSync(path.join(process.cwd(), 'fake-claude-record.json'), JSON.stringify(record, null, 2));
saveRecord();

const mcpConfigPath = flag('--mcp-config');
let mcp;
if (mcpConfigPath) {
  const cfg = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
  mcp = cfg.mcpServers?.claimdesk;
  record.mcpConfig = { type: mcp?.type, url: mcp?.url, hasAuth: Boolean(mcp?.headers?.Authorization) };
}

let rpcId = 0;
async function rpc(method, params) {
  const id = ++rpcId;
  const res = await fetch(mcp.url, {
    method: 'POST',
    headers: { ...mcp.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  record.mcp.push({ method, status: res.status, body });
  saveRecord();
  return { status: res.status, body };
}

const mcpStatus = has('mcp_down') ? 'failed' : 'connected';
emit({ type: 'system', subtype: 'init', model: flag('--model') ?? 'claude-opus-5-5', tools: [], mcp_servers: mcp ? [{ name: 'claimdesk', status: mcpStatus }] : [], permissionMode: flag('--permission-mode') });

if (has('sleep')) await sleep(60_000);

const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
emit({ type: 'rate_limit_event', rate_limit_info: { status: has('usage_event') ? 'rejected' : 'allowed', rateLimitType: 'five_hour', utilization: 42, resetsAt: resetEpoch } });

if (mcp && mcpStatus === 'connected') {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '2.1.300' } });
  await rpc('tools/list', {});
  for (const m of prompt.matchAll(/\[\[fake:call:([a-z_]+):(\{.*?\})\]\]/g)) {
    await rpc('tools/call', { name: m[1], arguments: JSON.parse(m[2]) });
  }
}

const base = { type: 'result', duration_ms: 1234, num_turns: 2, total_cost_usd: 0, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }, session_id: 'fake' };
if (has('no_result')) process.exit(1);
if (has('usage_event')) emit({ ...base, subtype: 'success', is_error: true, result: 'Rate limited' });
else if (has('api_error_limit')) emit({ ...base, subtype: 'success', is_error: true, result: 'API Error', api_error: 'usage_limit_reached', api_error_params: { rate_limit_info: { resetsAt: resetEpoch, rateLimitType: 'seven_day' } } });
else if (has('legacy_limit')) emit({ ...base, subtype: 'success', is_error: true, result: `Claude AI usage limit reached|${resetEpoch}` });
else if (has('window_limit')) emit({ ...base, subtype: 'success', is_error: true, result: `5-hour limit reached ∙ resets ${resetEpoch}` });
else if (has('auth')) emit({ ...base, subtype: 'success', is_error: true, result: 'OAuth token has expired. Please run /login' });
else if (has('pdf_too_large')) emit({ ...base, subtype: 'success', is_error: true, result: 'API Error', api_error: 'pdf_too_large' });
else if (has('invalid')) emit({ ...base, subtype: 'success', is_error: false, result: 'not json' });
else if (has('schema_retries')) emit({ ...base, subtype: 'error_max_structured_output_retries', is_error: true });
else if (has('max_turns')) emit({ ...base, subtype: 'error_max_turns', is_error: true });
else {
  const m = /\[\[fake:result:(\{.*?\})\]\]/s.exec(prompt);
  emit({ ...base, subtype: 'success', is_error: false, result: '', structured_output: m ? JSON.parse(m[1]) : {} });
}
saveRecord();
process.exit(0);
