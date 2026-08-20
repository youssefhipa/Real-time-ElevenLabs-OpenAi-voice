const startBtn = document.querySelector("#startBtn");
const stopBtn = document.querySelector("#stopBtn");
const statusEl = document.querySelector("#status");
const orb = document.querySelector("#orb");
const userTextEl = document.querySelector("#userText");
const assistantTextEl = document.querySelector("#assistantText");
const debugEl = document.querySelector("#debug");

let pc = null;
let dc = null;
let micStream = null;
let ttsSocket = null;
let audioContext = null;
let sessionAbortController = null;
let connectionAttempt = 0;

let activeResponseId = null;
let assistantText = "";
let userText = "";
let activeTtsDone = false;

let nextAudioTime = 0;
let scheduledSources = new Set();
let ttsGeneration = 0;

function log(...args) {
  const line = args
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ");
  debugEl.textContent += `${line}\n`;
  debugEl.scrollTop = debugEl.scrollHeight;
}

function setState(state, label) {
  orb.className = `orb ${state}`;
  statusEl.textContent = label;
}

function wsUrl(path) {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
}

function assertCurrentAttempt(attempt) {
  if (attempt !== connectionAttempt) {
    throw new DOMException("Connection attempt was cancelled.", "AbortError");
  }
}

function connectTtsSocket(attempt) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl("/tts"));
    ttsSocket = socket;
    let settled = false;

    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error("Timed out while connecting to ElevenLabs relay."));
    }, 10_000);

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      callback(value);
    };

    socket.addEventListener(
      "open",
      () => {
        try {
          assertCurrentAttempt(attempt);
          settle(resolve);
        } catch (error) {
          socket.close();
          settle(reject, error);
        }
      },
      { once: true }
    );
    socket.addEventListener(
      "error",
      () => settle(reject, new Error("Could not connect to the ElevenLabs relay.")),
      { once: true }
    );
    socket.addEventListener(
      "close",
      () => settle(reject, new Error("ElevenLabs relay closed during startup.")),
      { once: true }
    );

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        log("TTS ERROR: Invalid server message");
        return;
      }

      if (message.type === "audio") {
        if (message.responseId !== activeResponseId) return;
        queuePcm24k(message.audio, ttsGeneration).catch((error) => {
          log("AUDIO ERROR:", error.message || String(error));
        });
      }

      if (message.type === "tts_done" && message.responseId === activeResponseId) {
        activeTtsDone = true;
        log("ElevenLabs finished", message.responseId);

        if (scheduledSources.size === 0) {
          activeResponseId = null;
          setState("listening", "Listening");
        }
      }

      if (message.type === "error") {
        log("TTS ERROR:", message.message);
        setState("idle", message.message || "ElevenLabs TTS error");
      }
    });
  });
}

function sendTts(message) {
  if (ttsSocket?.readyState === WebSocket.OPEN) {
    ttsSocket.send(JSON.stringify(message));
  }
}

function stopAllPlayback() {
  ttsGeneration += 1;

  for (const source of scheduledSources) {
    try {
      source.stop();
    } catch {}
  }
  scheduledSources.clear();

  if (audioContext) {
    nextAudioTime = audioContext.currentTime;
  }
}

async function queuePcm24k(base64Audio, generationAtArrival) {
  if (!audioContext || generationAtArrival !== ttsGeneration) return;

  const binary = atob(base64Audio);
  const byteLength = binary.length - (binary.length % 2);
  if (byteLength === 0) return;

  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32768;
  }

  if (!audioContext || generationAtArrival !== ttsGeneration) return;

  const buffer = audioContext.createBuffer(1, samples.length, 24_000);
  buffer.copyToChannel(samples, 0);

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);

  const now = audioContext.currentTime;
  const startAt = Math.max(now + 0.015, nextAudioTime);
  source.start(startAt);
  nextAudioTime = startAt + buffer.duration;

  scheduledSources.add(source);
  source.onended = () => {
    scheduledSources.delete(source);

    if (
      scheduledSources.size === 0 &&
      generationAtArrival === ttsGeneration &&
      activeTtsDone
    ) {
      activeResponseId = null;
      setState("listening", "Listening");
    }
  };

  setState("speaking", "Speaking");
}

function interruptExternalVoice() {
  const interruptedResponseId = activeResponseId;
  stopAllPlayback();
  sendTts({ type: "interrupt", responseId: interruptedResponseId });
  activeResponseId = null;
  activeTtsDone = false;
}

function eventMatchesActiveResponse(event) {
  return !event.response_id || event.response_id === activeResponseId;
}

function handleRealtimeEvent(event) {
  switch (event.type) {
    case "session.created":
    case "session.updated":
      log(event.type);
      break;

    case "input_audio_buffer.speech_started":
      interruptExternalVoice();
      userText = "";
      userTextEl.textContent = "Listening…";
      userTextEl.classList.remove("muted");
      setState("listening", "Listening…");
      break;

    case "input_audio_buffer.speech_stopped":
      setState("thinking", "Thinking…");
      break;

    case "conversation.item.input_audio_transcription.delta":
      if (event.delta) {
        userText += event.delta;
        userTextEl.textContent = userText;
        userTextEl.classList.remove("muted");
      }
      break;

    case "conversation.item.input_audio_transcription.completed":
      if (event.transcript) {
        userText = event.transcript;
        userTextEl.textContent = userText;
        userTextEl.classList.remove("muted");
      }
      break;

    case "response.created":
      activeResponseId = event.response?.id || crypto.randomUUID();
      activeTtsDone = false;
      assistantText = "";
      assistantTextEl.textContent = "";
      assistantTextEl.classList.remove("muted");

      stopAllPlayback();
      sendTts({ type: "start", responseId: activeResponseId });
      setState("thinking", "Thinking…");
      break;

    case "response.output_text.delta":
      if (!activeResponseId || !eventMatchesActiveResponse(event)) break;

      assistantText += event.delta || "";
      assistantTextEl.textContent = assistantText;

      if (event.delta) {
        sendTts({
          type: "text",
          responseId: activeResponseId,
          text: event.delta,
        });
      }
      break;

    case "response.output_text.done":
      if (activeResponseId && eventMatchesActiveResponse(event)) {
        sendTts({ type: "end", responseId: activeResponseId });
      }
      break;

    case "response.done": {
      const status = event.response?.status || "";
      log("response.done", status);

      if (
        event.response?.id &&
        activeResponseId &&
        event.response.id !== activeResponseId
      ) {
        break;
      }

      if (["cancelled", "failed", "incomplete"].includes(status)) {
        interruptExternalVoice();
        if (status !== "cancelled") {
          setState("listening", `Response ${status}`);
        }
      }
      break;
    }

    case "error":
      console.error("OpenAI Realtime error:", event);
      log("OPENAI ERROR:", event);
      statusEl.textContent = event.error?.message || "OpenAI Realtime error";
      break;
  }
}

function releaseConversationResources({ notifyTts = true } = {}) {
  connectionAttempt += 1;
  sessionAbortController?.abort();
  sessionAbortController = null;

  stopAllPlayback();
  if (notifyTts) {
    sendTts({ type: "interrupt", responseId: activeResponseId });
  }

  try {
    dc?.close();
  } catch {}
  try {
    pc?.close();
  } catch {}
  try {
    ttsSocket?.close();
  } catch {}

  for (const track of micStream?.getTracks?.() || []) {
    track.stop();
  }

  if (audioContext && audioContext.state !== "closed") {
    audioContext.close().catch(() => {});
  }

  pc = null;
  dc = null;
  micStream = null;
  ttsSocket = null;
  audioContext = null;
  activeResponseId = null;
  activeTtsDone = false;
}

async function startConversation() {
  releaseConversationResources({ notifyTts: false });
  const attempt = ++connectionAttempt;

  startBtn.disabled = true;
  stopBtn.disabled = false;
  debugEl.textContent = "";
  userText = "";
  assistantText = "";
  userTextEl.textContent = "Listening for you…";
  assistantTextEl.textContent = "Waiting for the assistant…";
  setState("thinking", "Connecting…");

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("This browser does not support Web Audio.");
    }

    audioContext = new AudioContextClass();
    await audioContext.resume();
    assertCurrentAttempt(attempt);
    nextAudioTime = audioContext.currentTime;

    await connectTtsSocket(attempt);
    assertCurrentAttempt(attempt);

    pc = new RTCPeerConnection();
    pc.addEventListener("connectionstatechange", () => {
      if (attempt !== connectionAttempt) return;
      if (["failed", "disconnected"].includes(pc.connectionState)) {
        setState("idle", `Realtime connection ${pc.connectionState}`);
      }
    });

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    assertCurrentAttempt(attempt);

    for (const track of micStream.getTracks()) {
      pc.addTrack(track, micStream);
    }

    dc = pc.createDataChannel("oai-events");
    dc.addEventListener("open", () => {
      if (attempt !== connectionAttempt) return;
      log("OpenAI data channel open");
      setState("listening", "Listening");
    });
    dc.addEventListener("message", (message) => {
      try {
        handleRealtimeEvent(JSON.parse(message.data));
      } catch (error) {
        console.error(error);
        log("EVENT ERROR:", error.message || String(error));
      }
    });
    dc.addEventListener("close", () => log("OpenAI data channel closed"));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    assertCurrentAttempt(attempt);

    sessionAbortController = new AbortController();
    const sessionResponse = await fetch("/session", {
      method: "POST",
      body: offer.sdp,
      headers: { "Content-Type": "application/sdp" },
      signal: sessionAbortController.signal,
    });
    sessionAbortController = null;
    assertCurrentAttempt(attempt);

    if (!sessionResponse.ok) {
      throw new Error(await sessionResponse.text());
    }

    await pc.setRemoteDescription({
      type: "answer",
      sdp: await sessionResponse.text(),
    });
    assertCurrentAttempt(attempt);
  } catch (error) {
    if (attempt !== connectionAttempt || error?.name === "AbortError") return;

    console.error(error);
    log("START ERROR:", error.message || String(error));
    releaseConversationResources();
    setState("idle", "Could not start");
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

function stopConversation() {
  releaseConversationResources();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setState("idle", "Ended");
}

startBtn.addEventListener("click", startConversation);
stopBtn.addEventListener("click", stopConversation);
