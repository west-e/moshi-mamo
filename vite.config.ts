import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ブラウザ側。APIキーは持たず、/api はローカルの判定サーバーへ中継するだけ。
export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    // Windows で連続した編集の一部を取りこぼし、古い変換結果が配信されたことがあったため
    watch: { usePolling: true, interval: 300 },
    // /stt はローカル文字起こしサーバー（stt/server.py）。音声はこのパソコンの外に出ない
    proxy: { "/api": "http://127.0.0.1:8787", "/stt": "http://127.0.0.1:8788" },
  },
});
