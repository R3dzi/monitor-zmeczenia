import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Content-Security-Policy dodawana tylko do buildu produkcyjnego.
 * connect-src dopuszcza WYŁĄCZNIE własny origin i api.github.com, więc nawet
 * błąd w kodzie nie może wysłać tokenu ani pomiarów do innej usługi.
 */
function cspPlugin(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' https://api.github.com",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'self'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: csp },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig({
  // Ścieżki względne: działa na https://<user>.github.io/<repo>/ bez dodatkowej konfiguracji.
  base: './',
  plugins: [react(), cspPlugin()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 180000,
  },
});
