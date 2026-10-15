// Frontend configuration. The API is served from the same origin as these
// files by default. To point at another origin, set window.VAULT24_CONFIG
// before loading the app; the backend's FRONTEND_ORIGIN must then allow it.
export const API_BASE_URL = (window.VAULT24_CONFIG && window.VAULT24_CONFIG.apiBaseUrl) || '/api';

// Mirrors MAX_DOCUMENT_SIZE_BYTES on the server (preliminary check only;
// the server enforces the real limit and validates the PDF signature).
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

export const CURRENCY = 'ZMW';
export const MINOR_PER_MAJOR = 100; // 1 ZMW = 100 ngwee
export const ICONS = '/assets/icons/sprite.svg';
