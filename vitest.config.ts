import { defineConfig } from 'vitest/config';

/**
 * Gli alias `#` sono subpath imports di `package.json` e puntano a `dist/` per il runtime: in test
 * si risolve la condizione `development`, che punta ai sorgenti.
 */
export default defineConfig({
  resolve: {
    conditions: ['development', 'import', 'node'],
  },
  test: {
    environment: 'node',
    include:     ['tests/**/*.test.ts'],
    /**
     * Il logger scrive su stderr a livello `info`: in test diventerebbe rumore che nasconde i
     * fallimenti veri. Resta attivo per gli errori, che invece vanno visti.
     */
    env: {
      MAILBRIDGE_LOG_LEVEL: 'error',
    },
  },
});
