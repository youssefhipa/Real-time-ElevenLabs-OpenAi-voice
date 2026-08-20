import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createTtsConnectionHandler } from "../lib/tts-relay.js";

class FakeSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    FakeSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.emit("close");
  }

  receive(message) {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
}

class FakeBrowserSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = FakeSocket.OPEN;
    this.sent = [];
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  receive(message) {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
}

function setup() {
  FakeSocket.instances = [];
  const browser = new FakeBrowserSocket();
  const errors = [];
  const handler = createTtsConnectionHandler({
    apiKey: "test-key",
    voiceId: "my voice/id",
    WebSocketImpl: FakeSocket,
    createId: () => "generated-id",
    logger: { error: (...args) => errors.push(args) },
  });
  handler(browser);
  return { browser, errors };
}

test("reuses a prepared ElevenLabs socket for the next response", () => {
  const { browser } = setup();
  browser.receive({ type: "prepare" });
  const socket = FakeSocket.instances[0];
  socket.open();

  assert.equal(browser.sent.some((message) => message.type === "tts_ready"), false);

  browser.receive({ type: "start", responseId: "response-1" });

  assert.equal(FakeSocket.instances.length, 1);
  assert.deepEqual(browser.sent.at(-1), {
    type: "tts_ready",
    responseId: "response-1",
  });
});

test("queues response text while a prepared socket is still connecting", () => {
  const { browser } = setup();
  browser.receive({ type: "prepare" });
  const socket = FakeSocket.instances[0];

  browser.receive({ type: "start", responseId: "response-1" });
  browser.receive({
    type: "text",
    responseId: "response-1",
    text: "Start speaking quickly.",
  });
  socket.open();

  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(socket.sent[0].text, " ");
  assert.deepEqual(socket.sent[1], {
    text: "Start speaking quickly.",
    try_trigger_generation: true,
    flush: true,
  });
});

test("buffers initial text and flushes it after ElevenLabs opens", () => {
  const { browser } = setup();
  browser.receive({ type: "start", responseId: "response-1" });
  browser.receive({
    type: "text",
    responseId: "response-1",
    text: "This is enough text to begin.",
  });

  const socket = FakeSocket.instances[0];
  assert.equal(socket.sent.length, 0);
  socket.open();

  assert.equal(socket.sent[0].text, " ");
  assert.deepEqual(socket.sent[0].generation_config.chunk_length_schedule, [
    50, 80, 120, 150,
  ]);
  assert.deepEqual(socket.sent[1], {
    text: "This is enough text to begin.",
    try_trigger_generation: true,
    flush: true,
  });
  assert.deepEqual(browser.sent.at(-1), {
    type: "tts_ready",
    responseId: "response-1",
  });
});

test("flushes completed sentences before the response ends", () => {
  const { browser } = setup();
  browser.receive({ type: "start", responseId: "response-1" });
  const socket = FakeSocket.instances[0];
  socket.open();

  browser.receive({
    type: "text",
    responseId: "response-1",
    text: "Here is the first sentence.",
  });

  assert.deepEqual(socket.sent[1], {
    text: "Here is the first sentence.",
    try_trigger_generation: true,
    flush: true,
  });
});

test("flushes remaining audio and sends the documented end packet", () => {
  const { browser } = setup();
  browser.receive({ type: "start", responseId: "response-1" });
  const socket = FakeSocket.instances[0];
  socket.open();

  browser.receive({
    type: "text",
    responseId: "response-1",
    text: "An unfinished phrase",
  });
  browser.receive({ type: "end", responseId: "response-1" });

  assert.deepEqual(socket.sent.at(-1), { text: "" });
});

test("drops stale audio after a new response replaces an old generation", () => {
  const { browser } = setup();
  browser.receive({ type: "start", responseId: "old-response" });
  const oldSocket = FakeSocket.instances[0];
  oldSocket.open();

  browser.receive({ type: "start", responseId: "new-response" });
  const newSocket = FakeSocket.instances[1];
  assert.equal(oldSocket.readyState, FakeSocket.CLOSED);

  oldSocket.receive({ audio: "stale-audio" });
  newSocket.open();
  newSocket.receive({ audio: "current-audio" });

  const audioMessages = browser.sent.filter((message) => message.type === "audio");
  assert.deepEqual(audioMessages, [
    {
      type: "audio",
      responseId: "new-response",
      audio: "current-audio",
    },
  ]);
});

test("forwards ElevenLabs alignment with its matching audio chunk", () => {
  const { browser } = setup();
  browser.receive({ type: "start", responseId: "response-1" });
  const socket = FakeSocket.instances[0];
  socket.open();

  const alignment = {
    chars: ["H", "i"],
    char_start_times_ms: [0, 40],
    char_durations_ms: [40, 60],
  };
  socket.receive({ audio: "audio-data", normalizedAlignment: alignment });

  assert.match(socket.url, /sync_alignment=true/);
  assert.deepEqual(browser.sent.at(-1), {
    type: "audio",
    responseId: "response-1",
    audio: "audio-data",
    alignment,
  });
});

test("ignores text and end messages for a stale response", () => {
  const { browser } = setup();
  browser.receive({ type: "start", responseId: "current" });
  const socket = FakeSocket.instances[0];
  socket.open();

  browser.receive({
    type: "text",
    responseId: "stale",
    text: "This must never be spoken.",
  });
  browser.receive({ type: "end", responseId: "stale" });

  assert.deepEqual(socket.sent.map((message) => message.text), [" "]);
});

test("interrupt closes the active socket and blocks its buffered events", () => {
  const { browser } = setup();
  browser.receive({ type: "start", responseId: "response-1" });
  const socket = FakeSocket.instances[0];
  socket.open();

  browser.receive({ type: "interrupt", responseId: "response-1" });
  socket.receive({ audio: "late-audio", isFinal: true });

  assert.equal(socket.readyState, FakeSocket.CLOSED);
  assert.equal(browser.sent.some((message) => message.type === "audio"), false);
  assert.deepEqual(browser.sent.at(-1), {
    type: "interrupted",
    responseId: "response-1",
  });
});

test("reports malformed browser messages without crashing", () => {
  const { browser } = setup();
  browser.emit("message", Buffer.from("not-json"));

  assert.deepEqual(browser.sent, [{ type: "error", message: "Invalid TTS message." }]);
});
