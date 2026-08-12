import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Alliance Risk Group',
    template: '%s · Alliance Risk Group',
  },
  description:
    'AI-driven financial reporting for Alliance Risk Group — QuickBooks Online and HubSpot into live dashboards, forecasting and a grounded agent layer.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f9f9f7' },
    { media: '(prefers-color-scheme: dark)', color: '#0d0d0d' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Applies the stored theme before first paint so a dark-mode user never
          sees a white flash. Reads the same data-theme attribute the tokens key
          off, and leaves it unset for "system".
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('arg-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
