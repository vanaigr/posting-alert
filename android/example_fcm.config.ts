// FCM / Android build config.
// Values you control. The Firebase project id, app id, and API key live inside
// google-services.json (downloaded from the Firebase console) — they are not
// duplicated here.

export const ANDROID_PACKAGE = "com.myapp";

// Path (relative to project root) to the google-services.json you downloaded
// from Firebase console -> Project settings -> Your apps -> Android app.
// The package name registered in Firebase MUST match ANDROID_PACKAGE above.
export const GOOGLE_SERVICES_FILE = "./google-services.json";

// Channel used for displaying notifications on Android 8+.
// see /server/src/ashbyhq/run.ts
export const ANDROID_NOTIFICATION_CHANNEL_ID = "default";
