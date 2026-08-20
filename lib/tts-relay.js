import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const ELEVENLABS_MODEL = "eleven_flash_v2_5";
const ELEVENLABS_OUTPUT_FORMAT = "pcm_24000";
const FIRST_CHUNK_MIN_LENGTH = 12;
// ElevenLabs rejects any chunk schedule entry below 50. Starting at the
// minimum keeps first audio fast without invalidating the whole TTS stream.
const LOW_LATENCY_CHUNK_SCHEDULE = [50, 80, 120, 150];

function endsSentence(text) {
  return /[.!?][\s"')\]]*$/.test(text);
}

export function createTtsConnectionHandler({
  apiKey,
  voiceId,
  WebSocketImpl = WebSocket,
  createId = randomUUID,
  logger = console,
}) {
  return function handleTtsConnection(browserWs) {
    let activeGeneration = null;

    const browserSend = (message) => {
      if (browserWs.readyState === WebSocketImpl.OPEN) {
        browserWs.send(JSON.stringify(message));
      }
    };

    const isActive = (generation) =>
      activeGeneration === generation && !generation.closed;

    function closeGeneration(generation = activeGeneration) {
      if (!generation || generation.closed) return;

      generation.closed = true;
      generation.queue = [];
      generation.firstChunkBuffer = "";

      const socket = generation.socket;
      generation.socket = null;

      if (socket) {
        try {
          socket.close();
        } catch {}
      }

      if (activeGeneration === generation) {
        activeGeneration = null;
      }
    }

    function sendToEleven(generation, message) {
      if (!isActive(generation)) return;

      const socket = generation.socket;
      if (!socket || socket.readyState !== WebSocketImpl.OPEN) {
        generation.queue.push(message);
        return;
      }

      socket.send(JSON.stringify(message));
    }

    function flushQueue(generation, socket) {
      if (!isActive(generation) || generation.socket !== socket) return;

      for (const message of generation.queue) {
        socket.send(JSON.stringify(message));
      }
      generation.queue = [];
    }

    function createGeneration(responseId, prepared = false) {
      const generation = {
        responseId,
        prepared,
        socket: null,
        queue: [],
        closed: false,
        firstChunkPending: true,
        firstChunkBuffer: "",
      };
      activeGeneration = generation;

      const url =
        `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
        `/stream-input?model_id=${ELEVENLABS_MODEL}` +
        `&output_format=${ELEVENLABS_OUTPUT_FORMAT}` +
        `&inactivity_timeout=60&sync_alignment=true`;
      const socket = new WebSocketImpl(url);
      generation.socket = socket;

      socket.on("open", () => {
        if (!isActive(generation) || generation.socket !== socket) {
          try {
            socket.close();
          } catch {}
          return;
        }

        socket.send(
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
              chunk_length_schedule: LOW_LATENCY_CHUNK_SCHEDULE,
            },
            xi_api_key: apiKey,
          })
        );

        flushQueue(generation, socket);
        if (generation.responseId) {
          browserSend({ type: "tts_ready", responseId: generation.responseId });
        }
      });

      socket.on("message", (raw) => {
        // An interrupted socket may still emit buffered events. Never allow
        // those events to be labeled as, or played for, a newer response.
        if (!isActive(generation) || generation.socket !== socket) return;

        try {
          const data = JSON.parse(raw.toString());

          if (data.audio && generation.responseId) {
            const alignment = data.normalizedAlignment || data.alignment;
            browserSend({
              type: "audio",
              responseId: generation.responseId,
              audio: data.audio,
              ...(alignment ? { alignment } : {}),
            });
          }

          if ((data.isFinal || data.is_final) && generation.responseId) {
            browserSend({
              type: "tts_done",
              responseId: generation.responseId,
            });
          }
        } catch (error) {
          logger.error("Bad ElevenLabs WebSocket message:", error);
        }
      });

      socket.on("error", (error) => {
        if (!isActive(generation) || generation.socket !== socket) return;

        logger.error("ElevenLabs WebSocket error:", error);
        browserSend({
          type: "error",
          responseId: generation.responseId,
          message: "ElevenLabs TTS connection failed.",
        });
      });

      socket.on("close", () => {
        if (generation.socket === socket) {
          generation.socket = null;
        }
      });

      return generation;
    }

    function prepareGeneration() {
      if (activeGeneration?.prepared && !activeGeneration.closed) return;

      closeGeneration();
      createGeneration(null, true);
    }

    function startGeneration(responseId) {
      const normalizedResponseId =
        typeof responseId === "string" && responseId.length > 0
          ? responseId
          : createId();

      // Reuse the socket opened when the user stopped speaking. This hides
      // the ElevenLabs handshake inside OpenAI's response-generation time.
      if (
        activeGeneration?.prepared &&
        !activeGeneration.closed &&
        activeGeneration.socket
      ) {
        activeGeneration.responseId = normalizedResponseId;
        activeGeneration.prepared = false;

        if (activeGeneration.socket.readyState === WebSocketImpl.OPEN) {
          browserSend({
            type: "tts_ready",
            responseId: activeGeneration.responseId,
          });
        }
        return;
      }

      closeGeneration();
      createGeneration(normalizedResponseId);
    }

    function matchesActiveResponse(message) {
      return (
        activeGeneration &&
        (!message.responseId || message.responseId === activeGeneration.responseId)
      );
    }

    browserWs.on("message", (raw) => {
      let message;

      try {
        message = JSON.parse(raw.toString());
      } catch {
        browserSend({ type: "error", message: "Invalid TTS message." });
        return;
      }

      if (message.type === "start") {
        startGeneration(message.responseId);
        return;
      }

      if (message.type === "prepare") {
        prepareGeneration();
        return;
      }

      if (message.type === "text") {
        if (
          !matchesActiveResponse(message) ||
          typeof message.text !== "string" ||
          message.text.length === 0
        ) {
          return;
        }

        const generation = activeGeneration;
        if (generation.firstChunkPending) {
          generation.firstChunkBuffer += message.text;

          if (generation.firstChunkBuffer.length >= FIRST_CHUNK_MIN_LENGTH) {
            const text = generation.firstChunkBuffer;
            sendToEleven(generation, {
              text,
              try_trigger_generation: true,
              ...(endsSentence(text) ? { flush: true } : {}),
            });
            generation.firstChunkPending = false;
            generation.firstChunkBuffer = "";
          }
        } else {
          sendToEleven(generation, {
            text: message.text,
            ...(endsSentence(message.text) ? { flush: true } : {}),
          });
        }
        return;
      }

      if (message.type === "end") {
        if (!matchesActiveResponse(message)) return;

        const generation = activeGeneration;
        if (generation.firstChunkPending && generation.firstChunkBuffer) {
          sendToEleven(generation, {
            text: generation.firstChunkBuffer,
            try_trigger_generation: true,
            flush: true,
          });
          generation.firstChunkPending = false;
          generation.firstChunkBuffer = "";
        }
        // An empty text message is ElevenLabs' documented end-of-sequence
        // packet. The preceding text is already flushed above when needed.
        sendToEleven(generation, { text: "" });
        return;
      }

      if (message.type === "interrupt") {
        const responseId = activeGeneration?.responseId ?? null;
        closeGeneration();
        browserSend({ type: "interrupted", responseId });
      }
    });

    browserWs.on("close", () => closeGeneration());
  };
}
