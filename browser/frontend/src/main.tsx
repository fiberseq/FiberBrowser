// sandboxBootstrap MUST be the first import: a tour tab's requests and storage
// are redirected before any module (stores read localStorage at import) runs.
import './sandboxBootstrap';
// renderMode next, so its `?render=1` globals + html class land before any
// React module (including App's store imports) executes.
import './renderMode';
// The build's plugin packs (src/<pack>/fiberbrowser-pack.ts) are imported next, before the
// app's own modules, and registered below once the built-in panels are (plugins/packs.ts).
import './utils/randomUuidPolyfill';
import { loadPacks } from './plugins/packs';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './renderMode.css';
import './plugins'; // Initialize plugin registry
import { registerInsertionFeatures } from './features/register';
import './utils/appCommands'; // window.fiberbrowserCommand (the desktop app's menu bar)
import { initAnalysisPreferences } from './utils/analysisPreferences';
import { registerBrowserHost } from './plugins/browserHosts';
import { AppUpdateHost } from './components/appUpdate/AppUpdateHost';
import { initializePerformanceMode } from './stores/performanceStore';

// The insertion and variant features (a core module using the extension points), then the build's packs.
registerInsertionFeatures();
loadPacks();
// The update check (the quiet check at startup, its banner, the update dialog).
registerBrowserHost('app-update', AppUpdateHost, { interactiveOnly: true });

// The ChIP-Atlas choice, pinned and custom motifs kept on this computer (not per port): read once, then followed.
if (!window.__FIBERBROWSER_RENDER_MODE) void initAnalysisPreferences();

// The page itself never scrolls (index.css): if a focus or scrollIntoView still moves the root, put it back, or the
// top toolbar is cut off and every click lands above the pointer (seen in the Mac app's WKWebView).
window.addEventListener('scroll', () => {
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
}, { passive: true });

// Apply limits before panels fetch; changing them during that load starts it twice.
void initializePerformanceMode().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
