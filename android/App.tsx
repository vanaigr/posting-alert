import { useEffect, useState } from "react";
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Notifications from "expo-notifications";
import { ANDROID_NOTIFICATION_CHANNEL_ID } from "./fcm.config.ts";

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        if (Platform.OS === "android") {
          await Notifications.setNotificationChannelAsync(
            ANDROID_NOTIFICATION_CHANNEL_ID,
            {
              name: "Default",
              importance: Notifications.AndroidImportance.DEFAULT,
            },
          );
        }

        const existing = await Notifications.getPermissionsAsync();
        let status = existing.status;
        if (status !== "granted") {
          const req = await Notifications.requestPermissionsAsync();
          status = req.status;
        }
        if (status !== "granted") {
          setError("Notification permission not granted");
          return;
        }

        // Native FCM device token (NOT the Expo push token).
        const t = await Notifications.getDevicePushTokenAsync();
        setToken(typeof t.data === "string" ? t.data : JSON.stringify(t.data));
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    })();
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>FCM device token</Text>
      <Text style={styles.hint}>
        Paste this into the server. Requires a development build —
        Expo Go cannot receive FCM messages.
      </Text>
      <View style={styles.box}>
        <Text selectable style={styles.token}>
          {error ? `ERROR: ${error}` : (token ?? "Loading…")}
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    padding: 24,
    paddingTop: 64,
    backgroundColor: "#fff",
  },
  title: { fontSize: 20, fontWeight: "600", marginBottom: 8 },
  hint: { color: "#555", marginBottom: 16 },
  box: {
    padding: 12,
    backgroundColor: "#f3f3f3",
    borderRadius: 8,
  },
  token: { fontFamily: "monospace", fontSize: 13 },
});
