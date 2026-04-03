import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'me.portol.app',
  appName: 'Portol',
  webDir: 'dist/public',
  // Load from live server — the iOS app is a native wrapper around portol.me
  // This means updates deploy instantly without App Store review (for web content).
  // To use a local/bundled build instead, comment out the server block.
  server: {
    url: 'https://portol.me',
    cleartext: false,
    // Allow navigation to Google OAuth, Supabase auth callbacks
    allowNavigation: [
      'accounts.google.com',
      'uvaniovwrezzzlzmizyg.supabase.co',
      'portol.me',
    ],
  },
  ios: {
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    scheme: 'Portol',
    backgroundColor: '#0a0a0a',
    // Allow inline media playback
    allowsLinkPreview: false,
    scrollEnabled: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      backgroundColor: '#0a0a0a',
      showSpinner: false,
      splashImmersive: true,
      splashFullScreen: true,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0a0a0a',
    },
    Keyboard: {
      resize: 'body',
      style: 'DARK',
      resizeOnFullScreen: true,
    },
  },
};

export default config;
