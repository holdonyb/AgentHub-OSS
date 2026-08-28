import net from "node:net";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

let envelope;
try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  envelope = JSON.parse(input);
} catch (error) {
  fail(`invalid helper input: ${error.message}`);
}

if (!process.exitCode) {
  const { pipePath, request, timeoutMs = 30000 } = envelope;
  if (typeof pipePath !== "string" || !pipePath.startsWith("\\\\.\\pipe\\")) {
    fail("invalid Codex Desktop pipe path");
  } else if (!request || typeof request !== "object" || Array.isArray(request)) {
    fail("invalid JSON-RPC request");
  } else {
    const payload = Buffer.from(JSON.stringify(request), "utf8");
    if (payload.length > MAX_FRAME_BYTES) {
      fail("JSON-RPC request exceeds frame limit");
    } else {
      const frame = Buffer.allocUnsafe(4 + payload.length);
      frame.writeUInt32LE(payload.length, 0);
      payload.copy(frame, 4);

      await new Promise((resolve) => {
        const socket = net.createConnection(pipePath);
        let buffer = Buffer.alloc(0);
        let settled = false;
        const finish = (error, response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          if (error) fail(error.message || String(error));
          else process.stdout.write(JSON.stringify(response));
          resolve();
        };
        const timer = setTimeout(() => finish(new Error("Codex Desktop pipe timed out")), timeoutMs);
        socket.once("connect", () => socket.write(frame));
        socket.once("error", (error) => finish(error));
        socket.once("end", () => finish(new Error("Codex Desktop pipe closed before a response")));
        socket.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length >= 4) {
            const length = buffer.readUInt32LE(0);
            if (length > MAX_FRAME_BYTES) {
              finish(new Error("Codex Desktop response exceeds frame limit"));
              return;
            }
            if (buffer.length < 4 + length) return;
            const responseBytes = buffer.subarray(4, 4 + length);
            buffer = buffer.subarray(4 + length);
            try {
              const response = JSON.parse(responseBytes.toString("utf8"));
              if (request.id === undefined || response.id === request.id) {
                finish(null, response);
                return;
              }
            } catch (error) {
              finish(new Error(`invalid Codex Desktop response: ${error.message}`));
              return;
            }
          }
        });
      });
    }
  }
}
