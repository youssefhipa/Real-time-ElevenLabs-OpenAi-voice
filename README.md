# Realtime chatbot with your ElevenLabs voice

This project is a local prototype for a ChatGPT-style voice conversation while
keeping the assistant's spoken output in your cloned ElevenLabs voice.

The realtime path is:

1. The browser sends microphone audio directly to OpenAI Realtime over WebRTC.
2. OpenAI semantic VAD detects natural turn boundaries and interruptions.
3. OpenAI maintains the conversation and streams a text response.
4. The local server streams that text to ElevenLabs.
5. The browser schedules ElevenLabs PCM audio for low-latency playback.
6. If you begin speaking, queued audio and the active ElevenLabs generation stop immediately.

API keys stay on the server and are never sent in the public frontend files.

## Requirements

- Node.js 20 or newer
- An OpenAI API key with Realtime access
- An ElevenLabs API key
- The ElevenLabs voice ID for your cloned voice

## Setup

Copy the example configuration and enter your credentials:

```bash
cp .env.example .env
npm install
```

```env
OPENAI_API_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
PORT=3000
REALTIME_MODEL=gpt-realtime-2.1
REALTIME_VAD_EAGERNESS=high
```

Start the app:

```bash
npm start
```

Open `http://localhost:3000`, allow microphone permission, and press
**Start conversation**. If you change `PORT`, use that port in the URL instead.

The server exits with a clear message if a required setting is missing, a value
is invalid, or the configured port is already occupied.

## Natural turn-taking

`REALTIME_VAD_EAGERNESS=high` is the recommended setting for the lowest turn-end
latency. Available values are:

- `low` — gives longer pauses more time before ending your turn
- `medium` — balanced explicit setting
- `high` — responds quickly but may cut off a thoughtful pause
- `auto` — the default OpenAI behavior; currently equivalent to `medium`

After changing `.env`, restart the server.

## ElevenLabs output

The relay uses `eleven_flash_v2_5` with `pcm_24000` and a low-latency chunk
schedule. It begins generating from early text deltas and flushes completed
sentences, so speech starts before OpenAI finishes the full response. The app also
prepares the next ElevenLabs connection as soon as you stop speaking, overlapping
its handshake with OpenAI's response time. Each OpenAI response owns a separate
ElevenLabs generation. When a new response starts or you interrupt, the old
generation is closed and any delayed audio from it is discarded.

The **Debug events** panel reports time from the end of your turn to the OpenAI
response, first text, ElevenLabs readiness, and first audio. This makes it clear
which service is responsible if a particular turn feels slow.

## Verification

Run linting and automated tests together:

```bash
npm run check
```

Useful manual checks:

1. Have a normal multi-turn conversation.
2. Pause mid-sentence, then finish the thought.
3. Interrupt while the cloned voice is speaking.
4. Interrupt repeatedly and quickly.
5. End and restart the conversation several times.
6. Temporarily use an invalid API key and confirm that the UI reports the failure.

The automated tests cover configuration validation, initial text buffering,
response-ID isolation, stale audio rejection, and interruption cleanup in the TTS relay.

## Security

- Keep real credentials only in `.env`; it is ignored by Git.
- Keep `.env.example` limited to blank placeholders and non-secret defaults.
- Rotate a key immediately if it is ever committed, shared, or copied into logs.
