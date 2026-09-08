import { loadConfig } from './config/index.js';
import { startServer } from './server.js';

try {
  loadConfig();
} catch (error) {
  // The logger itself needs configuration, so this one failure is reported on
  // stderr directly.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

startServer();
