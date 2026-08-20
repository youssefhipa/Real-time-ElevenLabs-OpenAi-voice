# OpenAI Realtime + ElevenLabs cloned voice

This is a local prototype where:

- OpenAI Realtime receives your microphone audio directly over WebRTC.
- OpenAI semantic VAD decides when your turn starts/ends.
- OpenAI handles conversation state, reasoning, and interruptions.
- OpenAI returns text only.
- The text is streamed to ElevenLabs.
- ElevenLabs speaks it using your `ELEVENLABS_VOICE_ID`.
- If you speak while the assistant is talking, the browser immediately stops queued ElevenLabs audio and the current ElevenLabs generation.

## Requirements

- Node.js 20+
- An OpenAI API key with access to Realtime
- An ElevenLabs API key
- An ElevenLabs voice ID

## Setup

1. Copy `.env.example` to `.env`

```bash
cp .env.example .env
```

2. Fill in:

```env
OPENAI_API_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
PORT=3000
```

3. Install dependencies:

```bash
npm install
```

4. Start:

```bash
npm start
```

5. Open:

```text
http://localhost:3000
```

6. Allow microphone permission and press **Start conversation**.

## Good test

Say:

> I want to talk about AI stocks, but give me a second to think...

Pause briefly, continue your thought, and then interrupt the assistant while it is speaking.

## Tuning

In `server.js`, change:

```js
eagerness: "auto"
```

to:

- `"low"` — waits longer before taking the turn
- `"medium"` — balanced
- `"high"` — responds faster
- `"auto"` — default semantic behavior

For a ChatGPT-like natural conversation, start with `auto`.

ElevenLabs uses:

```text
eleven_flash_v2_5
```

for low-latency TTS and requests `pcm_24000`, which the browser schedules through the Web Audio API.

## Security

Never put either API key in `public/app.js` or `public/index.html`.
The server reads both keys from `.env`.
