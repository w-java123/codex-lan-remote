package dev.codexlan.remote;

import android.content.Context;
import java.io.*;
import java.net.*;
import org.json.JSONObject;

final class ApkUpdateDownload {
    static final String NAME = "codex-lan-update.apk";

    interface Progress { void show(String message,int percent); }
    static File prepare(Context context, JSONObject release,Progress progress) throws Exception {
        JSONObject full = release.getJSONObject("android");
        long size = full.optLong("size");
        if (size <= 0 || size > ApkDelta.LIMIT || !hasDigest(full)) throw new IOException("缺少安装包校验信息");
        File installed = new File(context.getApplicationInfo().sourceDir);
        JSONObject patches = release.optJSONObject("patches");
        JSONObject patch = patches == null ? null : patches.optJSONObject(ApkDelta.digest(installed).substring(7));
        File directory = context.getCacheDir();
        File result = new File(directory, NAME);
        File working = File.createTempFile("update-", ".apk", directory);
        try {
            if (patch != null && hasDigest(patch) && patch.optLong("size") > 0 && patch.optLong("size") < size) {
                File delta = File.createTempFile("update-", ".cld", directory);
                try {
                    download(patch,delta,"正在下载增量更新",progress);
                    progress.show("正在还原并校验更新包…",-1);
                    ApkDelta.apply(installed,delta,working,size);
                    if(!full.getString("digest").equals(ApkDelta.digest(working)))throw new IOException("合成安装包校验失败");
                } catch(IOException patchFailure) {
                    download(full,working,"正在下载完整更新",progress);
                } finally { delta.delete(); }
            } else download(full,working,"正在下载完整更新",progress);
            if (!working.renameTo(result)) throw new IOException("无法保存更新包");
            return result;
        } finally { working.delete(); }
    }

    private static boolean hasDigest(JSONObject asset) {
        return asset.optString("digest").matches("sha256:[a-f0-9]{64}");
    }

    private static void download(JSONObject asset,File file,String label,Progress progress)throws Exception {
        URL target = new URL(UpdatePolicy.downloadUrl(asset.getString("url")));
        for (int redirects = 0; redirects < 4; redirects++) {
            HttpURLConnection connection = (HttpURLConnection) target.openConnection();
            try {
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(12000);
                connection.setReadTimeout(20000);
                int code = connection.getResponseCode();
                if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                    URI next = target.toURI().resolve(connection.getHeaderField("Location"));
                    String host = next.getHost();
                    if (!"https".equals(next.getScheme()) || next.getUserInfo() != null || next.getPort() != -1 ||
                        !("release-assets.githubusercontent.com".equals(host) || "objects.githubusercontent.com".equals(host) ||
                          "github-releases.githubusercontent.com".equals(host) || !UpdatePolicy.downloadUrl(next.toString()).isEmpty())) {
                        throw new IOException("更新下载重定向无效");
                    }
                    target = next.toURL();
                    continue;
                }
                if (code != 200) throw new IOException("更新包下载失败");
                final long expected = asset.getLong("size");
                long total = 0;
                int lastPercent=-1;
                try (InputStream input = connection.getInputStream(); OutputStream output = new FileOutputStream(file)) {
                    byte[] bytes = new byte[64 * 1024];
                    int read;
                    while ((read = input.read(bytes)) != -1) {
                        total += read;
                        if (total > expected) throw new IOException("更新包大小不符");
                        output.write(bytes, 0, read);
                        int percent=(int)(100*total/expected);
                        if(percent!=lastPercent){lastPercent=percent;progress.show(label,percent);}
                    }
                }
                progress.show("正在校验下载内容…",-1);
                if (total != expected || !asset.getString("digest").equals(ApkDelta.digest(file))) throw new IOException("更新包校验失败");
                return;
            } finally { connection.disconnect(); }
        }
        throw new IOException("更新下载重定向过多");
    }
}
