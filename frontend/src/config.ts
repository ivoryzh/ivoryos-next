// Where this UI is served from: '' as the edge serves it; '/tour/app' in the tour build (next.config.ts).
// A <Link> adds it on its own; a hard navigation (`window.location.href = ...`) has to.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';
export const withBase = (path: string) => `${BASE_PATH}${path}`;
export const API_BASE = process.env.NODE_ENV === 'development' ? 'http://localhost:8080' : '';
export const WS_BASE = API_BASE ? API_BASE.replace('http', 'ws') : (typeof window !== 'undefined' ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}` : '');
