package com.lifttracker.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Native support for self-updating the sideloaded APK from GitHub releases.
 * Handles permission prompting for "Install unknown apps" and launching
 * the system Package Installer with a content:// URI via FileProvider.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.trim().isEmpty()) {
            call.reject("Missing 'path' (relative to app cache dir)");
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                // Android 8+ requires the "install unknown sources" permission at runtime.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    if (!getContext().getPackageManager().canRequestPackageInstalls()) {
                        // Signal to JS layer so it can guide the user.
                        // We also proactively open the settings screen.
                        openUnknownSourcesSettings();
                        call.reject("permission_required");
                        return;
                    }
                }

                File apkFile = resolveCacheFile(path);
                if (!apkFile.exists() || !apkFile.isFile()) {
                    call.reject("APK file not found at " + path);
                    return;
                }

                String authority = getContext().getPackageName() + ".fileprovider";
                Uri apkUri = FileProvider.getUriForFile(getContext(), authority, apkFile);

                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                getContext().startActivity(intent);
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "Unknown error launching installer");
            }
        });
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        openUnknownSourcesSettings();
        call.resolve();
    }

    /**
     * Check whether the app currently has permission to request installs from unknown sources.
     * On Android 8+ (API 26+) this is the runtime "Install unknown apps" toggle.
     * Returns { canInstall: boolean }.
     */
    @PluginMethod
    public void canInstallFromUnknownSources(PluginCall call) {
        boolean canInstall = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            canInstall = getContext().getPackageManager().canRequestPackageInstalls();
        }
        JSObject ret = new JSObject();
        ret.put("canInstall", canInstall);
        call.resolve(ret);
    }

    private void openUnknownSourcesSettings() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            } catch (Exception ignored) {
                // If the specific intent fails, fall back to general settings (rare)
                try {
                    Intent fallback = new Intent(Settings.ACTION_SECURITY_SETTINGS);
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(fallback);
                } catch (Exception ignored2) {}
            }
        }
    }

    /**
     * Resolve a relative path (e.g. "updates/lift-tracker-update.apk") against the app's cache directory.
     * Matches what @capacitor/filesystem writes when using Directory.Cache.
     */
    private File resolveCacheFile(String relativePath) {
        File cacheRoot = getContext().getCacheDir();
        // Normalize any leading slashes the caller might have sent
        String clean = relativePath.startsWith("/") ? relativePath.substring(1) : relativePath;
        return new File(cacheRoot, clean);
    }

    /**
     * Download the APK from the given URL (GitHub release asset) directly in native code.
     * This is more reliable than JS fetch for large binaries in the WebView.
     * Reports progress via notifyListeners("downloadProgress", { progress: 0-100 }).
     * On success resolves with { path: "updates/lift-tracker-update.apk" }.
     */
    @PluginMethod
    public void downloadUpdate(PluginCall call) {
        String urlStr = call.getString("url");
        if (urlStr == null || urlStr.trim().isEmpty()) {
            call.reject("Missing 'url'");
            return;
        }
        long expectedSize = call.getLong("expectedSize", 0L);

        // Run download off the main thread
        new Thread(() -> {
            HttpURLConnection connection = null;
            InputStream input = null;
            FileOutputStream output = null;
            try {
                File cacheRoot = getContext().getCacheDir();
                File updatesDir = new File(cacheRoot, "updates");
                if (!updatesDir.exists() && !updatesDir.mkdirs()) {
                    call.reject("Failed to create updates directory");
                    return;
                }
                File apkFile = new File(updatesDir, "lift-tracker-update.apk");

                URL url = new URL(urlStr);
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36");
                connection.setRequestProperty("Accept", "application/octet-stream, */*");
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(60000); // longer for large APK
                connection.connect();

                int responseCode = connection.getResponseCode();
                if (responseCode != HttpURLConnection.HTTP_OK) {
                    // Read error body for useful message (rate limit, etc.)
                    String errorBody = "";
                    try {
                        InputStream errStream = connection.getErrorStream();
                        if (errStream != null) {
                            java.util.Scanner s = new java.util.Scanner(errStream).useDelimiter("\\A");
                            errorBody = s.hasNext() ? s.next() : "";
                        }
                    } catch (Exception ignored) {}
                    call.reject("Server returned HTTP " + responseCode + (errorBody.isEmpty() ? "" : ": " + errorBody.substring(0, 300)));
                    return;
                }

                int fileLength = connection.getContentLength();
                if (expectedSize > 0 && fileLength > 0 && fileLength != expectedSize) {
                    call.reject("Server reported wrong size: " + fileLength + " (expected " + expectedSize + ")");
                    return;
                }

                // Quick check: if content length suspiciously small, read as text
                if (fileLength > 0 && fileLength < 10000) {
                    try {
                        InputStream smallStream = connection.getInputStream();
                        java.util.Scanner s = new java.util.Scanner(smallStream).useDelimiter("\\A");
                        String body = s.hasNext() ? s.next() : "";
                        call.reject("GitHub returned small non-APK content (" + fileLength + " bytes): " + body.substring(0, 300));
                        return;
                    } catch (Exception ignored) {}
                }

                input = connection.getInputStream();
                output = new FileOutputStream(apkFile);

                byte[] data = new byte[8192];
                long total = 0;
                int count;
                while ((count = input.read(data)) != -1) {
                    total += count;
                    output.write(data, 0, count);
                    if (fileLength > 0) {
                        int progress = (int) ((total * 100) / fileLength);
                        JSObject ret = new JSObject();
                        ret.put("progress", progress);
                        notifyListeners("downloadProgress", ret);
                    }
                }

                output.flush();

                // Verify size if expected provided
                if (expectedSize > 0 && apkFile.length() != expectedSize) {
                    apkFile.delete();
                    call.reject("Download corrupted (size mismatch: got " + apkFile.length() + " bytes, expected " + expectedSize + ")");
                    return;
                }

                JSObject ret = new JSObject();
                ret.put("path", "updates/lift-tracker-update.apk");
                call.resolve(ret);

            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "Download failed");
            } finally {
                try {
                    if (output != null) output.close();
                    if (input != null) input.close();
                    if (connection != null) connection.disconnect();
                } catch (Exception ignored) {}
            }
        }).start();
    }
}
