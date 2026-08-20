import "dotenv/config";
import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  PORT = 3000,
} = process.env;

for (const [name, value] of Object.entries({
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
})) {
  if (!value) {
    console.warn(`⚠️  Missing ${name} in .env`);
  }
}

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.text({ type: ["application/sdp", "text/plain"], limit: "2mb" }));

const sessionConfig = {
  type: "realtime",
  model: "gpt-realtime-2.1",
  output_modalities: ["text"],
  instructions: `
You are a natural, intelligent conversational assistant.

You are being used in a live voice conversation.
Speak naturally, directly, and conversationally.
Keep normal answers concise enough to sound good when spoken aloud.
Do not mention internal reasoning.
Do not narrate tool calls.
Do not say things like "as an AI".
You may discuss markets, technology, business, science, travel, or general topics.

If the user pauses mid-thought, let the realtime turn detector decide when the turn is complete.
When the user interrupts or changes direction, adapt immediately.
  `.trim(),
  audio: {
    input: {
      turn_detection: {
        type: "semantic_vad",
        eagerness: "high",
        create_response: true,
        interrupt_response: true,
      },
      transcription: {
        model: "gpt-transcribe",
      },
    },
  },
};

app.post("/session", async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).send("OPENAI_API_KEY is missing");
  }

  try {
    const fd = new FormData();
    fd.set("sdp", req.body);
    fd.set("session", JSON.stringify(sessionConfig));

    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Safety-Identifier": "local-internal-voice-test",
      },
      body: fd,
    });

    const body = await response.text();

    if (!response.ok) {
      console.error("OpenAI Realtime session error:", body);
      return res.status(response.status).send(body);
    }

    res.type("application/sdp").send(body);
  } catch (error) {
    console.error("Could not create OpenAI Realtime session:", error);
    res.status(500).send("Could not create OpenAI Realtime session");
  }
});

// Browser <-> local server WebSocket for ElevenLabs TTS.
const wss = new WebSocketServer({ server, path: "/tts" });

wss.on("connection", (browserWs) => {
  let elevenWs = null;
  let currentResponseId = null;
  let queuedMessages = [];
  let generationClosed = false;
  let firstChunkPending = false;
  let firstChunkBuffer = "";

  const browserSend = (message) => {
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify(message));
    }
  };

  function closeEleven() {
    generationClosed = true;
    queuedMessages = [];

    if (elevenWs) {
      try {
        elevenWs.close();
      } catch {}
      elevenWs = null;
    }
  }

  function flushQueue() {
    if (!elevenWs || elevenWs.readyState !== WebSocket.OPEN) return;

    for (const msg of queuedMessages) {
      elevenWs.send(JSON.stringify(msg));
    }
    queuedMessages = [];
  }

  function sendToEleven(message) {
    if (!elevenWs || elevenWs.readyState !== WebSocket.OPEN) {
      queuedMessages.push(message);
      return;
    }
    elevenWs.send(JSON.stringify(message));
  }

  function startEleven(responseId) {
    closeEleven();

    generationClosed = false;
    firstChunkPending = true;
    firstChunkBuffer = "";
    currentResponseId = responseId || crypto.randomUUID();

    if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
      browserSend({
        type: "error",
        message: "Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID in .env",
      });
      return;
    }

    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}` +
      `/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_24000`;

    elevenWs = new WebSocket(url);

    elevenWs.on("open", () => {
      if (generationClosed) return;

      // ElevenLabs requires an initial message.
      elevenWs.send(
        JSON.stringify({
          text: " ",
          voice_settings: {
            stability: 0.75,
            similarity_boost: 1.0,
            style: 0.15,
            use_speaker_boost: false,
            speed: 1.0,
          },
          generation_config: {
            chunk_length_schedule: [50, 90, 120, 150],
          },
          xi_api_key: ELEVENLABS_API_KEY,
        })
      );

      flushQueue();

      browserSend({
        type: "tts_ready",
        responseId: currentResponseId,
      });
    });

    elevenWs.on("message", (raw) => {
      if (generationClosed) return;

      try {
        const data = JSON.parse(raw.toString());

        if (data.audio) {
          browserSend({
            type: "audio",
            responseId: currentResponseId,
            audio: data.audio,
          });
        }

        if (data.isFinal || data.is_final) {
          browserSend({
            type: "tts_done",
            responseId: currentResponseId,
          });
        }
      } catch (error) {
        console.error("Bad ElevenLabs WebSocket message:", error);
      }
    });

    elevenWs.on("error", (error) => {
      console.error("ElevenLabs WebSocket error:", error);
      browserSend({
        type: "error",
        message: "ElevenLabs TTS connection failed.",
      });
    });

    elevenWs.on("close", () => {
      elevenWs = null;
    });
  }

  browserWs.on("message", (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === "start") {
      startEleven(message.responseId);
      return;
    }

    if (message.type === "text") {
      if (!generationClosed && message.text) {
        if (firstChunkPending) {
          firstChunkBuffer += message.text;

          // Wait for a small amount of context (a few words) before forcing
          // the first ElevenLabs generation, so it has enough to judge
          // natural pacing instead of guessing from a single word.
          if (firstChunkBuffer.length >= 20) {
            sendToEleven({
              text: firstChunkBuffer,
              try_trigger_generation: true,
            });
            firstChunkPending = false;
            firstChunkBuffer = "";
          }
        } else {
          sendToEleven({ text: message.text });
        }
      }
      return;
    }

    if (message.type === "end") {
      if (!generationClosed) {
        if (firstChunkPending && firstChunkBuffer) {
          sendToEleven({
            text: firstChunkBuffer,
            try_trigger_generation: true,
          });
          firstChunkPending = false;
          firstChunkBuffer = "";
        }
        sendToEleven({ text: "" });
      }
      return;
    }

    if (message.type === "interrupt") {
      closeEleven();
      browserSend({ type: "interrupted" });
      return;
    }
  });

  browserWs.on("close", closeEleven);
});

server.listen(PORT, () => {
  console.log(`\nVoice test running at http://localhost:${PORT}`);
  console.log("Press Ctrl+C to stop.\n");
});
