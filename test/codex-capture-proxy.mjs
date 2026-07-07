// Logging reverse proxy: codex -> 127.0.0.1:8378 -> chatgpt.com/backend-api/codex
// Captures full request/response bodies (incl. SSE) to capture.jsonl.
// Authorization/cookie headers are redacted in the log.
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { appendFileSync } from "node:fs";
import {
  zstdDecompressSync,
  gunzipSync,
  brotliDecompressSync,
  inflateSync,
} from "node:zlib";

const decompress = (buf, encoding) => {
  try {
    switch ((encoding || "").toLowerCase()) {
      case "zstd":
        return zstdDecompressSync(buf);
      case "gzip":
        return gunzipSync(buf);
      case "br":
        return brotliDecompressSync(buf);
      case "deflate":
        return inflateSync(buf);
      default:
        return buf;
    }
  } catch {
    return buf;
  }
};

const PORT = 8378;
const UPSTREAM_HOST = "chatgpt.com";
const UPSTREAM_PREFIX = "/backend-api/codex";
const LOG = new URL("./capture.jsonl", import.meta.url).pathname;

const redact = (headers) => {
  const out = { ...headers };
  for (const k of Object.keys(out)) {
    if (/authorization|cookie|api-key/i.test(k)) out[k] = "<redacted>";
  }
  return out;
};

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const reqBody = Buffer.concat(chunks);
    const upstreamPath = UPSTREAM_PREFIX + req.url;
    const headers = { ...req.headers, host: UPSTREAM_HOST };
    delete headers["content-length"];

    const upstreamReq = httpsRequest(
      { host: UPSTREAM_HOST, path: upstreamPath, method: req.method, headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        const respChunks = [];
        upstreamRes.on("data", (c) => {
          respChunks.push(c);
          res.write(c); // stream through
        });
        upstreamRes.on("end", () => {
          res.end();
          const reqDecoded = decompress(reqBody, req.headers["content-encoding"]);
          let parsedReq;
          try {
            parsedReq = JSON.parse(reqDecoded.toString("utf8"));
          } catch {
            parsedReq = reqDecoded.toString("utf8").slice(0, 4000);
          }
          appendFileSync(
            LOG,
            JSON.stringify({
              ts: new Date().toISOString(),
              method: req.method,
              path: req.url,
              upstreamPath,
              requestHeaders: redact(req.headers),
              requestBody: parsedReq,
              status: upstreamRes.statusCode,
              responseHeaders: upstreamRes.headers,
              responseBody: Buffer.concat(respChunks).toString("utf8"),
            }) + "\n",
          );
          console.log(`${req.method} ${req.url} -> ${upstreamRes.statusCode}`);
        });
      },
    );
    upstreamReq.on("error", (e) => {
      console.error("upstream error:", e.message);
      res.writeHead(502).end("proxy upstream error");
    });
    upstreamReq.end(reqBody);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`capture proxy on :${PORT} -> https://${UPSTREAM_HOST}${UPSTREAM_PREFIX}, log: ${LOG}`));
