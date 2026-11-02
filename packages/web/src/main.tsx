import { createRoot } from 'react-dom/client';
import '@fontsource/spectral/400.css';
import '@fontsource/spectral/400-italic.css';
import '@fontsource/spectral/600.css';
import '@fontsource-variable/hanken-grotesk';
import './styles.css';
import { App } from './App.tsx';
import { BASE } from './lib/data.ts';

createRoot(document.getElementById('root')!).render(<App />);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => { navigator.serviceWorker.register(new URL('sw.js', BASE)).catch(() => {}); });
}
