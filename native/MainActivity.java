package com.local.claudeaccountmanager;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoSessionSettings;
import org.mozilla.geckoview.GeckoView;
import org.mozilla.geckoview.WebExtension;

import java.util.ArrayList;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GeckoBrowser.class);
        super.onCreate(savedInstanceState);
    }

    // Jembatan JS -> native: GeckoBrowser.open({ accountId, url }) dan GeckoBrowser.takePending()
    @CapacitorPlugin(name = "GeckoBrowser")
    public static class GeckoBrowser extends Plugin {
        private static GeckoBrowser sInstance;
        // Status halaman (limit / busy / reset / idle) yang terdeteksi saat layar utama sedang di belakang browser.
        // Tiap item: {accountId, state, text, url, waktu-ms}
        private static final ArrayList<String[]> PENDING = new ArrayList<>();

        @Override
        public void load() {
            sInstance = this;
        }

        // Dipanggil dari GeckoActivity saat halaman melapor status
        static synchronized void emit(String accountId, String state, String text, String url) {
            long now = System.currentTimeMillis();
            boolean dup = false;
            if (!PENDING.isEmpty()) {
                String[] last = PENDING.get(PENDING.size() - 1);
                if (last[0].equals(accountId) && last[1].equals(state) && last[2].equals(text)) {
                    // Laporan yang sama (mis. heartbeat busy): cukup perbarui url dan waktunya
                    last[3] = url;
                    last[4] = String.valueOf(now);
                    dup = true;
                }
            }
            if (!dup) {
                PENDING.add(new String[]{accountId, state, text, url, String.valueOf(now)});
                if (PENDING.size() > 20) PENDING.remove(0);
            }
            if (sInstance != null) {
                JSObject data = new JSObject();
                data.put("accountId", accountId);
                data.put("state", state);
                data.put("text", text);
                data.put("url", url);
                data.put("at", now);
                sInstance.notifyListeners("pageText", data);
            }
        }

        @PluginMethod
        public void open(PluginCall call) {
            Intent i = new Intent(getActivity(), GeckoActivity.class);
            i.putExtra("accountId", call.getString("accountId", "default"));
            i.putExtra("url", call.getString("url", "https://claude.ai/new"));
            getActivity().startActivity(i);
            call.resolve();
        }

        // Mengambil dan mengosongkan antrean banner limit
        @PluginMethod
        public void takePending(PluginCall call) {
            JSArray arr = new JSArray();
            synchronized (GeckoBrowser.class) {
                for (String[] it : PENDING) {
                    JSObject o = new JSObject();
                    o.put("accountId", it[0]);
                    o.put("state", it[1]);
                    o.put("text", it[2]);
                    o.put("url", it[3]);
                    o.put("at", Long.parseLong(it[4]));
                    arr.put(o);
                }
                PENDING.clear();
            }
            JSObject res = new JSObject();
            res.put("items", arr);
            call.resolve(res);
        }
    }

    // Layar browser (mesin Firefox). Tiap akun = contextId sendiri = cookie/login terpisah.
    public static class GeckoActivity extends Activity {
        private static final String EXT_URI = "resource://android/assets/public/limitwatch/";
        private static final String EXT_ID = "limitwatch@app.local";

        private static GeckoRuntime sRuntime;
        private static boolean sExtReady = false;
        private static volatile String sCurrentAccountId = "default";

        // Menerima status halaman (limit / busy / reset / idle) dari ekstensi limitwatch
        private static final WebExtension.MessageDelegate MESSAGE_DELEGATE =
                new WebExtension.MessageDelegate() {
                    @Override
                    public GeckoResult<Object> onMessage(String nativeApp, Object message,
                                                         WebExtension.MessageSender sender) {
                        try {
                            if (message instanceof JSONObject) {
                                JSONObject msg = (JSONObject) message;
                                String state = msg.optString("state", "limit");
                                String text = msg.optString("text", "");
                                String url = msg.optString("url", "");
                                if (!"limit".equals(state) || !text.isEmpty()) {
                                    GeckoBrowser.emit(sCurrentAccountId, state, text, url);
                                }
                            }
                        } catch (Exception ignored) {
                        }
                        return null;
                    }
                };

        private GeckoSession session;
        private boolean canGoBack = false;

        @Override
        protected void onCreate(Bundle savedInstanceState) {
            super.onCreate(savedInstanceState);

            String accountId = getIntent().getStringExtra("accountId");
            String url = getIntent().getStringExtra("url");
            if (accountId == null) accountId = "default";
            if (url == null) url = "https://claude.ai/new";
            sCurrentAccountId = accountId;

            if (sRuntime == null) {
                sRuntime = GeckoRuntime.create(getApplicationContext());
            }

            GeckoSessionSettings settings = new GeckoSessionSettings.Builder()
                    .contextId(accountId)
                    .build();
            session = new GeckoSession(settings);
            session.setNavigationDelegate(new GeckoSession.NavigationDelegate() {
                @Override
                public void onCanGoBack(GeckoSession s, boolean can) {
                    canGoBack = can;
                }
            });
            session.open(sRuntime);

            GeckoView view = new GeckoView(this);
            view.setSession(session);

            FrameLayout root = new FrameLayout(this);
            root.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            root.addView(buildHomeButton(), homeButtonParams());
            setContentView(root);

            loadWhenReady(url);
        }

        // Halaman dimuat setelah ekstensi terpasang supaya content script ikut aktif
        private void loadWhenReady(final String url) {
            if (sExtReady) {
                session.loadUri(url);
                return;
            }
            sRuntime.getWebExtensionController()
                    .ensureBuiltIn(EXT_URI, EXT_ID)
                    .accept(
                            ext -> {
                                if (ext != null) {
                                    ext.setMessageDelegate(MESSAGE_DELEGATE, "browser");
                                    sExtReady = true;
                                }
                                if (session != null) session.loadUri(url);
                            },
                            err -> {
                                if (session != null) session.loadUri(url);
                            });
        }

        // Tombol beranda melayang di tepi kiri. Menutup browser dan kembali ke aplikasi.
        private TextView buildHomeButton() {
            float d = getResources().getDisplayMetrics().density;
            TextView b = new TextView(this);
            b.setText("⌂");
            b.setTextSize(22f);
            b.setTextColor(Color.WHITE);
            b.setGravity(Gravity.CENTER);
            b.setAlpha(0.88f);
            b.setElevation(12 * d);
            GradientDrawable bg = new GradientDrawable();
            bg.setShape(GradientDrawable.OVAL);
            bg.setColor(0xCC071524);
            bg.setStroke((int) (1 * d), 0x667DD3FC);
            b.setBackground(bg);
            b.setContentDescription("Kembali ke beranda aplikasi");
            b.setOnClickListener(v -> finish());
            return b;
        }

        private FrameLayout.LayoutParams homeButtonParams() {
            float d = getResources().getDisplayMetrics().density;
            int size = (int) (44 * d);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                    size, size, Gravity.START | Gravity.CENTER_VERTICAL);
            lp.leftMargin = (int) (6 * d);
            return lp;
        }

        @Override
        public void onBackPressed() {
            if (canGoBack && session != null) {
                session.goBack();
            } else {
                finish();
            }
        }

        @Override
        protected void onDestroy() {
            if (session != null) {
                session.close();
                session = null;
            }
            super.onDestroy();
        }
    }
}
