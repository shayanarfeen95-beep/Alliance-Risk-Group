import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ConfigurationNeeded } from '@/components/shell/configuration-needed';

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

/**
 * What this deployment cannot run without.
 *
 * Both of these used to fail deep inside a request instead of here. A missing
 * DATABASE_URL threw on the first query; a missing AUTH_SECRET threw only when
 * somebody signed in, because the key is not needed until a cookie is minted —
 * so the site looked healthy, every page rendered, and the login form returned a
 * bare 500 with a digest and nothing else. That is the worst possible shape for
 * a configuration error: it looks like a broken application rather than an
 * unfinished setup.
 *
 * Reading environment variables opens nothing and costs nothing, so it is done
 * once, here, where it can be answered with a screen that names them.
 */
function missingRequiredEnv(): string[] {
  if (process.env.NODE_ENV !== 'production') return [];

  return [
    !process.env.DATABASE_URL && 'DATABASE_URL',
    !process.env.AUTH_SECRET && 'AUTH_SECRET',
  ].filter((name): name is string => typeof name === 'string');
}

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
      {/*
        Checked here rather than left to fail deeper in: without a database every
        page throws the same error, and a 500 with a digest tells the person who
        deployed it nothing. This is a pure environment check — it opens no
        connection — so it costs nothing on a configured deployment.
      */}
      <body>
        {missingRequiredEnv().length > 0 ? (
          <ConfigurationNeeded missing={missingRequiredEnv()} />
        ) : (
          children
        )}
      </body>
    </html>
  );
}
