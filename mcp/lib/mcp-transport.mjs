/**
 * Minimal MCP (Model Context Protocol) stdio JSON-RPC transport.
 * Zero dependencies — implements just enough of the spec for tool serving.
 */

export function createStdioTransport({ serverInfo, tools, onToolCall }) {
  let buffer = "";

  function send(message) {
    const json = JSON.stringify(message);
    process.stdout.write(json + "\n");
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    const { id, method, params } = msg;

    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo,
        },
      });
      return;
    }

    if (method === "notifications/initialized") {
      // Client acknowledged — no response needed
      return;
    }

    if (method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const tool = tools.find((t) => t.name === toolName);
      if (!tool) {
        send({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `Unknown tool: ${toolName}` }], isError: true },
        });
        return;
      }
      Promise.resolve(onToolCall(toolName, toolArgs))
        .then((result) => {
          const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
        })
        .catch((err) => {
          send({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true },
          });
        });
      return;
    }

    // Unknown method
    if (id !== undefined) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line) handleMessage(line);
    }
  });

  process.stdin.on("end", () => {
    process.exit(0);
  });
}
