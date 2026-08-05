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
    contentInset: 'always',
    preferredContentMode: 'mobile',
    scheme: 'Portol',
    backgroundColor: '#0a0a0a',
    // Allow inline media playback
    allowsLinkPreview: false,
    scrollEnabled: true,
    // Permission descriptions for App Store
    infoPlist: {
      NSMicrophoneUsageDescription: 'Portol uses the microphone for voice commands in the chat.',
      NSCameraUsageDescription: 'Portol uses the camera to scan documents and receipts.',
      NSPhotoLibraryUsageDescription: 'Portol accesses your photos to upload documents.',
      // HealthKit. Both strings must be present before the HealthKit capability
      // can be enabled in Xcode — a build without them crashes on first access,
      // and App Review rejects it. Portol only READS; the update string is here
      // because Apple wants it declared whenever the entitlement is present.
      NSHealthShareUsageDescription:
        'Portol reads steps, sleep, heart rate, weight and other health data so your Wellness page and health score stay up to date without you logging them by hand.',
      NSHealthUpdateUsageDescription:
        'Portol does not write to Apple Health. This permission is declared only because the HealthKit capability requires it.',
    },
    // Required alongside the HealthKit entitlement enabled in Xcode
    // (Signing & Capabilities → + Capability → HealthKit).
    // See docs/APP_STORE_GUIDE.md § HealthKit.
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
