import React from 'react';
import { createRoot } from 'react-dom/client';

// App shell is implemented by the web build agents. See docs/ARCHITECTURE.md.
function App() {
  return <div style={{ fontFamily: 'system-ui', padding: 24 }}>ClaimDesk — build pending</div>;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
