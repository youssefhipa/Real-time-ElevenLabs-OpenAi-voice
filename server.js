import "dotenv/config";
import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { loadConfig } from "./lib/config.js";
import { createTtsConnectionHandler } from "./lib/tts-relay.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));
app.use(express.text({ type: ["application/sdp", "text/plain"], limit: "2mb" }));

const sessionConfig = {
  type: "realtime",
  model: config.realtimeModel,
  output_modalities: ["text"],
  instructions: `
You are a natural, intelligent conversational assistant in a live voice conversation.

Speak naturally, directly, and conversationally. Keep normal answers concise enough
to sound good when spoken aloud. Do not mention internal reasoning, narrate tool calls,
or say things like "as an AI". If the user interrupts or changes direction, adapt
immediately. Let the realtime turn detector decide when a paused thought is complete.
  `.trim(),
  audio: {
    input: {
      turn_detection: {
        type: "semantic_vad",
        eagerness: config.vadEagerness,
        create_response: true,
        interrupt_response: true,
      },
      transcription: {
        model: "gpt-transcribe",
      },
    },
  },
};

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/session", async (req, res) => {
  if (typeof req.body !== "string" || req.body.trim().length === 0) {
    return res.status(400).send("A WebRTC SDP offer is required.");
  }

  try {
    const fd = new FormData();
    fd.set("sdp", req.body);
    fd.set("session", JSON.stringify(sessionConfig));

    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openAiApiKey}`,
        "OpenAI-Safety-Identifier": "local-internal-voice-test",
      },
      body: fd,
      signal: AbortSignal.timeout(20_000),
    });

    const body = await response.text();

    if (!response.ok) {
      console.error(`OpenAI Realtime session error (${response.status}):`, body);
      return res
        .status(response.status)
        .send(`OpenAI Realtime session failed (${response.status}). Check the server log.`);
    }

    return res.type("application/sdp").send(body);
  } catch (error) {
    const timedOut = error?.name === "TimeoutError";
    console.error("Could not create OpenAI Realtime session:", error);
    return res
      .status(timedOut ? 504 : 502)
      .send(
        timedOut
          ? "OpenAI Realtime session timed out."
          : "Could not create OpenAI Realtime session."
      );
  }
});

const wss = new WebSocketServer({ server, path: "/tts", maxPayload: 64 * 1024 });
wss.on(
  "connection",
  createTtsConnectionHandler({
    apiKey: config.elevenLabsApiKey,
    voiceId: config.elevenLabsVoiceId,
  })
);
wss.on("error", (error) => {
  console.error("TTS WebSocket server error:", error);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Cannot start: port ${config.port} is already in use. Change PORT in .env.`);
  } else if (error.code === "EACCES") {
    console.error(`Cannot start: permission denied for port ${config.port}.`);
  } else {
    console.error("Server error:", error);
  }
  process.exitCode = 1;
});

server.listen(config.port, () => {
  console.log(`\nVoice test running at http://localhost:${config.port}`);
  console.log("Press Ctrl+C to stop.\n");
});
