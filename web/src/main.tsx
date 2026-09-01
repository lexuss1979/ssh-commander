import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { LangProvider } from './i18n';
import './styles.css';

// LangProvider — вокруг всего App: выше auth-guard, чтобы LoginPage
// тоже имел доступ к контексту языка.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LangProvider>
      <App />
    </LangProvider>
  </React.StrictMode>,
);

