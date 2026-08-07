export const API_BASE = process.env.NODE_ENV === 'development' ? 'http://localhost:8080' : '';
export const WS_BASE = API_BASE ? API_BASE.replace('http', 'ws') : (typeof window !== 'undefined' ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}` : '');
