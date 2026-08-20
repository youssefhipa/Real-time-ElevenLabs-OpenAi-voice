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
  assert.deepEqual(socket.sent[1], {
    text: "This is enough text to begin.",
    try_trigger_generation: true,
  });
  assert.deepEqual(browser.sent.at(-1), {
    type: "tts_ready",
    responseId: "response-1",
  });
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
