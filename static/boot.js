import { api, stream } from './local-backend.js';

globalThis.__PQ_BACKEND__ = { api, stream };
await import('./app.js');
