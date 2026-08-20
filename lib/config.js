const REQUIRED_ENV_NAMES = [
  "OPENAI_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
];

export function loadConfig(env = process.env) {
  const missing = REQUIRED_ENV_NAMES.filter((name) => !env[name]?.trim());

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable${missing.length === 1 ? "" : "s"}: ${missing.join(
        ", "
      )}. Copy .env.example to .env and fill in the blank values.`
    );
  }

  const rawPort = env.PORT?.trim() || "3000";
  const port = Number(rawPort);
  const vadEagerness = env.REALTIME_VAD_EAGERNESS?.trim() || "auto";

  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535; received ${JSON.stringify(rawPort)}.`);
  }

  if (!["low", "medium", "high", "auto"].includes(vadEagerness)) {
    throw new Error(
      `REALTIME_VAD_EAGERNESS must be low, medium, high, or auto; received ${JSON.stringify(
        vadEagerness
      )}.`
    );
  }

  return {
    openAiApiKey: env.OPENAI_API_KEY.trim(),
    elevenLabsApiKey: env.ELEVENLABS_API_KEY.trim(),
    elevenLabsVoiceId: env.ELEVENLABS_VOICE_ID.trim(),
    port,
    realtimeModel: env.REALTIME_MODEL?.trim() || "gpt-realtime-2.1",
    vadEagerness,
  };
}
