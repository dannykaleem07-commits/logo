import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { ManagerModeProvider } from './app/managerMode';
import { createAppRouter } from './app/router';
import { installSessionExpiryRedirect } from './app/session';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import { isApiError } from './api/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/manager.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      // never hammer a dead API; 4xx are final
      retry: (failureCount, error) => {
        if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      }
    },
    mutations: { retry: 0 }
  }
});

const router = createAppRouter();

// Any API 401 (session missing or expired) outside the sign-in screen → /login?next=<current page>.
installSessionExpiryRedirect((to) => router.navigate(to, { replace: true }), queryClient);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ManagerModeProvider>
            <RouterProvider router={router} />
          </ManagerModeProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

// PWA: the service worker caches the app shell only (never /api). Registered in production builds so the
// dev server's HMR is never served from cache.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => console.warn('[ClaimDesk] service worker registration failed', err));
  });
}
