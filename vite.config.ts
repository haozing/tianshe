import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '127.0.0.1', // 明确使用 IPv4 localhost
    port: 5273, // Windows 可能排除 5123-5222 等端口段，换用 5273
    strictPort: true, // 端口需与 Electron 的 wait-on/loadURL 保持一致
  },
});
