import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../lib/config.js";

const validEnv = {
  OPENAI_API_KEY: "openai-test-key",
  ELEVENLABS_API_KEY: "eleven-test-key",
  ELEVENLABS_VOICE_ID: "voice-id",
};

test("loadConfig applies conversation-friendly defaults", () => {
  assert.deepEqual(loadConfig(validEnv), {
    openAiApiKey: "openai-test-key",
    elevenLabsApiKey: "eleven-test-key",
    elevenLabsVoiceId: "voice-id",
    port: 3000,
    realtimeModel: "gpt-realtime-2.1",
    vadEagerness: "auto",
  });
});

test("loadConfig reports all missing required values", () => {
  assert.throws(
    () => loadConfig({ PORT: "3000" }),
    /OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID/
  );
});

test("loadConfig validates port and VAD eagerness", () => {
  assert.throws(() => loadConfig({ ...validEnv, PORT: "70000" }), /PORT must be/);
  assert.throws(
    () => loadConfig({ ...validEnv, REALTIME_VAD_EAGERNESS: "instant" }),
    /REALTIME_VAD_EAGERNESS must be/
  );
});

test("loadConfig accepts explicit model, port, and VAD settings", () => {
  const config = loadConfig({
    ...validEnv,
    PORT: "4567",
    REALTIME_MODEL: "realtime-test-model",
    REALTIME_VAD_EAGERNESS: "low",
  });

  assert.equal(config.port, 4567);
  assert.equal(config.realtimeModel, "realtime-test-model");
  assert.equal(config.vadEagerness, "low");
});
