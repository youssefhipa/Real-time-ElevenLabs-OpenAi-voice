import js from "@eslint/js";

export default [
  {
    ignores: ["node_modules/**"],
  },
  js.configs.recommended,
  {
    files: ["server.js", "lib/**/*.js", "test/**/*.js"],
    languageOptions: {
      globals: {
        AbortSignal: "readonly",
        Buffer: "readonly",
        FormData: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
      },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      globals: {
        AbortController: "readonly",
        DOMException: "readonly",
        RTCPeerConnection: "readonly",
        WebSocket: "readonly",
        atob: "readonly",
        console: "readonly",
        crypto: "readonly",
        document: "readonly",
        fetch: "readonly",
        location: "readonly",
        navigator: "readonly",
        window: "readonly",
      },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
