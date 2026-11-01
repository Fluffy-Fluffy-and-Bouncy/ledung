import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import { THEME_KEY, applyTheme, parseTheme, readTheme } from './theme.ts';
import { setPasskeyCalls } from './api.ts';
import { browserPasskeys } from './passkey.ts';
import { followKeyboard } from './phoneKeyboard.ts';
import { PasskeyDialog } from './components/PasskeyDialog.tsx';
import { followFramingPage } from './settingsStore.ts';

// Through the public name, page-key actions ask for the phone's passkey (#160).
setPasskeyCalls(browserPasskeys);

// Before the first render, so a chosen scheme shows from the start (#113); another tab's choice follows.
applyTheme(document.documentElement, readTheme(localStorage));
window.addEventListener('storage', (e) => {
  // No key: a clear in another tab, or the framing page's settings taken (#459); read what is there now.
  if (e.key === THEME_KEY) applyTheme(document.documentElement, parseTheme(e.newValue));
  else if (e.key === null) applyTheme(document.documentElement, readTheme(localStorage));
});

// In a frame on another computer's page, Settings → Look's choices are kept by that page (#459).
followFramingPage();

// The shell ends above an iPhone's keyboard, so the message box stays in view (#174).
followKeyboard(window);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {/* Before and after a passkey prompt through the public name (#179). */}
    <PasskeyDialog />
  </StrictMode>,
);
