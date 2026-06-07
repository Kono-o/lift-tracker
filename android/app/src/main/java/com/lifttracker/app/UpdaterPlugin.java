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
}
