import { api, stream } from './local-backend.js';

globalThis.__YFL_BACKEND__ = { api, stream };
await import('./app.js');
