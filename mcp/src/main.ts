/**
 * The compiled server's entry point. It starts the server unconditionally: inside a compiled
 * executable `import.meta.main` cannot be relied on (on Windows the server loaded, found nothing to
 * do and quit), and index.ts must not start itself when the tests import it.
 */
import { start } from './index.js';

start();
