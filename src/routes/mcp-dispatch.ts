/**
 * JSON-RPC dispatcher for the MCP route (concept §9).
 *
 * Thin coordinator that wires together the JSON-RPC envelope helpers
 * ({@link `./mcp/json-rpc.ts`}), the `initialize` handler
 * ({@link `./mcp/initialize.ts`}) and the `tools/list` + `tools/call`
 * handlers ({@link `./mcp/tools.ts`}). Keeping the dispatcher itself slim
 * makes the JSON-RPC method table easy to scan and keeps every sub-module
 * comfortably below the project-wide per-file line budget.
 *
 * Re-exports the public surface used by {@link `./mcp.ts`} so the route
 * registration code keeps importing from a single module.
 */
import type { FastifyRequest } from "fastify";

import { initialize } from "./mcp/initialize.js";
import {
  jsonRpcError,
  JsonRpcErrorCode,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type ParsedEnvelope,
} from "./mcp/json-rpc.js";
import { handleToolsCall, listTools } from "./mcp/tools.js";

export { SUPPORTED_PROTOCOL_VERSIONS } from "./mcp/initialize.js";
export {
  jsonRpcError,
  JsonRpcErrorCode,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcResponse,
  type JsonRpcSuccess,
  jsonRpcSuccess,
  type ParsedEnvelope,
  parseJsonRpcEnvelope,
} from "./mcp/json-rpc.js";

/**
 * Dispatches a parsed JSON-RPC envelope to the matching MCP handler and
 * returns the response envelope. The caller is responsible for sending the
 * envelope as the HTTP body.
 */
export async function dispatchMethod(
  request: FastifyRequest,
  userId: string,
  envelope: ParsedEnvelope,
): Promise<JsonRpcResponse> {
  const app = request.server;
  const { id, method, params } = envelope;
  switch (method) {
    case "initialize":
      return jsonRpcSuccess(id, initialize(app, params));
    case "tools/list":
      return jsonRpcSuccess(id, listTools(app.config.features));
    case "tools/call":
      return handleToolsCall({ app, userId, request }, id, params);
    default:
      return jsonRpcError(id, {
        code: JsonRpcErrorCode.METHOD_NOT_FOUND,
        message: `Unknown method "${method}"`,
      });
  }
}
