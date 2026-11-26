package com.catledger.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;

/**
 * 分类账 CatLedger 的 Android 外壳。
 *
 * 设计要点：
 *  1. 不用 Gradle / AndroidX，纯 framework API，体积小、构建快。
 *  2. 页面来自 assets/www，file:// 加载，完全离线，零网络权限。
 *  3. 数据不走 WebView 的 localStorage（file:// 下行为不稳定），
 *     而是通过 AppBridge 写入应用私有目录，原子替换，避免写坏。
 *  4. 返回键先交给网页的 window.__back()，网页返回 false 才退出 App。
 */
public class MainActivity extends Activity {

    private WebView web;
    private boolean darkMode;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        darkMode = isSystemDark();
        buildWebView();
        setContentView(web);
        applyBars(darkMode);
        web.loadUrl("file:///android_asset/index.html");
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void buildWebView() {
        web = new WebView(this);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setDefaultTextEncodingName("UTF-8");
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setBackgroundColor(bgColor(darkMode));

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // 纯本地应用：不允许任何跳转离开页面
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "AppBridge");
    }

    private static int bgColor(boolean dark) {
        return dark ? 0xFF0F1113 : 0xFFF6F7F9;
    }

    private boolean isSystemDark() {
        int mode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES;
    }

    private void applyBars(boolean dark) {
        Window w = getWindow();
        int bg = bgColor(dark);
        w.setStatusBarColor(bg);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            w.setNavigationBarColor(bg);
        }
        View decor = w.getDecorView();
        int flags = decor.getSystemUiVisibility();
        if (dark) {
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        } else {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (dark) {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            } else {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
        }
        decor.setSystemUiVisibility(flags);
        if (web != null) {
            web.setBackgroundColor(bg);
            w.setBackgroundDrawableResource(dark ? R.color.appBgDark : R.color.appBg);
        }
    }

    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript(
                "(function(){try{return (window.__back && window.__back())?'true':'false'}catch(e){return 'false'}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (value == null || !value.contains("true")) {
                            finish();
                        }
                    }
                });
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("AppBridge");
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /* ---------------- JS 桥 ---------------- */
    public class Bridge {

        @JavascriptInterface
        public String systemDark() {
            return isSystemDark() ? "1" : "0";
        }

        @JavascriptInterface
        public void setStatusBarColor(final boolean dark) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    darkMode = dark;
                    applyBars(dark);
                }
            });
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void copyText(final String text) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        cm.setPrimaryClip(ClipData.newPlainText("分类账备份", text));
                        Toast.makeText(MainActivity.this, "已复制到剪贴板", Toast.LENGTH_SHORT).show();
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "复制失败", Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public String storageGet(String key) {
            File f = storeFile(key);
            if (f == null || !f.exists()) return null;
            return readText(f);
        }

        @JavascriptInterface
        public boolean storageSet(String key, String value) {
            File f = storeFile(key);
            if (f == null || value == null) return false;
            return writeAtomic(f, value);
        }
    }

    /* ---------------- 文件读写 ---------------- */
    private File storeFile(String key) {
        if (key == null) return null;
        String safe = key.replaceAll("[^A-Za-z0-9._-]", "_");
        if (safe.length() == 0) return null;
        return new File(getFilesDir(), safe + ".json");
    }

    private String readText(File f) {
        InputStream in = null;
        try {
            in = new FileInputStream(f);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), "UTF-8");
        } catch (Exception e) {
            return null;
        } finally {
            if (in != null) try { in.close(); } catch (Exception ignore) { }
        }
    }

    private boolean writeAtomic(File target, String data) {
        File tmp = new File(target.getParentFile(), target.getName() + ".tmp");
        FileOutputStream out = null;
        boolean wrote = false;
        try {
            out = new FileOutputStream(tmp);
            out.write(data.getBytes("UTF-8"));
            out.flush();
            try { out.getFD().sync(); } catch (Exception ignore) { }
            wrote = true;
        } catch (Exception e) {
            wrote = false;
        } finally {
            if (out != null) try { out.close(); } catch (Exception ignore) { }
        }
        if (!wrote) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            return false;
        }
        if (target.exists() && !target.delete()) {
            return false;
        }
        return tmp.renameTo(target);
    }
}