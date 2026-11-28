import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.glacetorremedies.bms',
  appName: 'Glacetor BMS',
  webDir: 'dist',
  backgroundColor: '#0F2744',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
