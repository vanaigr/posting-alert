import type { ExpoConfig } from "expo/config";
import {
  ANDROID_PACKAGE,
  GOOGLE_SERVICES_FILE,
} from "./fcm.config.ts";

const config: ExpoConfig = {
  name: "android",
  slug: "android",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  newArchEnabled: true,
  splash: {
    image: "./assets/splash-icon.png",
    resizeMode: "contain",
    backgroundColor: "#ffffff",
  },
  ios: {
    supportsTablet: true,
  },
  android: {
    package: ANDROID_PACKAGE,
    googleServicesFile: GOOGLE_SERVICES_FILE,
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#ffffff",
    },
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: [
    "expo-notifications",
    [
      "expo-build-properties",
      {
        android: { usesCleartextTraffic: true },
      },
    ],
  ],
};

export default config;
