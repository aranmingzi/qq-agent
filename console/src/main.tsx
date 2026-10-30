import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import App from '@/App';
import { ThemeProvider } from '@/providers/theme-provider';
import { ToastProvider } from '@/providers/toast-provider';
import { ConsoleModeProvider } from '@/providers/console-mode-provider';
import { NavigationGuardProvider } from '@/providers/navigation-guard-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import '@/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <ConsoleModeProvider>
          <NavigationGuardProvider>
            <TooltipProvider delayDuration={180} skipDelayDuration={300}>
              <App />
            </TooltipProvider>
          </NavigationGuardProvider>
        </ConsoleModeProvider>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
