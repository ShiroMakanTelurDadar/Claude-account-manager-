package com.local.claudeaccountmanager;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
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
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GeckoBrowser.class);
        super.onCreate(savedInstanceState);
    }

    // Hasil pengecekan satu akun di sesi browser tersembunyi
    interface CheckCallback {
        void done(JSObject res);
    }

    // Jembatan JS -> native: open, check, takePending, codeAccess, openCodeAccess
    @CapacitorPlugin(name = "GeckoBrowser")
    public static class GeckoBrowser extends Plugin {
        private static GeckoBrowser sInstance;
        private static Context sAppCtx;
        // Status halaman (limit / busy / reset / idle / loggedout) yang terdeteksi saat layar utama sedang di belakang browser.
        // Tiap item: {accountId, state, text, url, waktu-ms}
        private static final ArrayList<String[]> PENDING = new ArrayList<>();

        // Kode verifikasi login terbaru dari notifikasi Gmail (6 digit)
        private static String sCode = null;
        private static long sCodeAt = 0;
        private static boolean sCodeUsed = true;
        private static String sLastClipCode = null;
        private static final Pattern CLIP_CODE = Pattern.compile("^\\s*(\\d{3})[\\s-]?(\\d{3})\\s*$");

        @Override
        public void load() {
            sInstance = this;
            sAppCtx = getContext().getApplicationContext();
        }

        // Dipanggil CodeListener saat ada notifikasi Gmail berisi kode
        static synchronized void putCode(String code) {
            sCode = code;
            sCodeAt = System.currentTimeMillis();
            sCodeUsed = false;
        }

        // Kode terbaru (maksimal 10 menit) dan hanya sekali pakai. Cadangan: isi clipboard yang persis 6 digit.
        static synchronized String takeCode() {
            if (sCode != null && !sCodeUsed && System.currentTimeMillis() - sCodeAt < 10 * 60 * 1000L) {
                sCodeUsed = true;
                return sCode;
            }
            return clipboardCode();
        }

        private static String clipboardCode() {
            try {
                if (sAppCtx == null) return null;
                ClipboardManager cm = (ClipboardManager) sAppCtx.getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm == null || !cm.hasPrimaryClip()) return null;
                ClipData cd = cm.getPrimaryClip();
                if (cd == null || cd.getItemCount() == 0) return null;
                CharSequence t = cd.getItemAt(0).getText();
                if (t == null) return null;
                Matcher m = CLIP_CODE.matcher(t.toString());
                if (!m.matches()) return null;
                String code = m.group(1) + m.group(2);
                if (code.equals(sLastClipCode)) return null;
                sLastClipCode = code;
                return code;
            } catch (Exception e) {
                return null;
            }
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
            i.putExtra("email", call.getString("email", ""));
            getActivity().startActivity(i);
            call.resolve();
        }

        // Cek satu akun di belakang layar: muat chat di sesi tersembunyi, tunggu laporan halaman, lalu tutup
        @PluginMethod
        public void check(final PluginCall call) {
            final String accountId = call.getString("accountId", "default");
            final String url = call.getString("url", "https://claude.ai/new");
            Integer t = call.getInt("timeoutMs", 24000);
            final int timeout = t == null ? 24000 : t;
            GeckoActivity.runCheck(getContext().getApplicationContext(), accountId, url, timeout,
                    new CheckCallback() {
                        @Override
                        public void done(JSObject res) {
                            call.resolve(res);
                        }
                    });
        }

        // Apakah izin baca notifikasi (untuk kode Gmail) sudah aktif
        @PluginMethod
        public void codeAccess(PluginCall call) {
            String s = Settings.Secure.getString(getContext().getContentResolver(), "enabled_notification_listeners");
            JSObject r = new JSObject();
            r.put("enabled", s != null && s.contains(getContext().getPackageName()));
            call.resolve(r);
        }

        // Buka halaman setelan Android tempat izin baca notifikasi diaktifkan
        @PluginMethod
        public void openCodeAccess(PluginCall call) {
            Intent i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(i);
            call.resolve();
        }

        // Mengambil dan mengosongkan antrean laporan halaman
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

    // Membaca notifikasi email dari Gmail dan mengambil kode verifikasi login Claude (6 digit).
    // Aktif setelah pengguna memberi izin "Akses notifikasi" untuk aplikasi ini.
    public static class CodeListener extends NotificationListenerService {
        private static final Pattern FROM_CLAUDE = Pattern.compile("claude|anthropic", Pattern.CASE_INSENSITIVE);
        private static final Pattern CODE = Pattern.compile("(?<!\\d)(\\d{3})[\\s-]?(\\d{3})(?!\\d)");

        @Override
        public void onNotificationPosted(StatusBarNotification sbn) {
            try {
                String pkg = sbn.getPackageName();
                if (!"com.google.android.gm".equals(pkg) && !"com.google.android.gm.lite".equals(pkg)) return;
                Bundle ex = sbn.getNotification().extras;
                if (ex == null) return;
                StringBuilder sb = new StringBuilder();
                String[] keys = {"android.title", "android.text", "android.bigText", "android.subText", "android.summaryText"};
                for (String k : keys) {
                    CharSequence cs = ex.getCharSequence(k);
                    if (cs != null) sb.append(cs).append('\n');
                }
                CharSequence[] lines = ex.getCharSequenceArray("android.textLines");
                if (lines != null) {
                    for (CharSequence cs : lines) {
                        if (cs != null) sb.append(cs).append('\n');
                    }
                }
                String all = sb.toString();
                if (!FROM_CLAUDE.matcher(all).find()) return;
                Matcher m = CODE.matcher(all);
                if (m.find()) GeckoBrowser.putCode(m.group(1) + m.group(2));
            } catch (Exception ignored) {
            }
        }
    }

    // Layar browser (mesin Firefox). Tiap akun = contextId sendiri = cookie/login terpisah.
    public static class GeckoActivity extends Activity {
        private static final String EXT_URI = "resource://android/assets/public/limitwatch/";
        private static final String EXT_ID = "limitwatch@app.local";

        private static GeckoRuntime sRuntime;
        private static boolean sExtReady = false;
        private static volatile String sCurrentAccountId = "default";
        private static volatile String sCurrentEmail = "";

        // Pengecekan latar belakang: selama sCheckAccountId tidak null, laporan halaman dicatat di sini
        private static volatile String sCheckAccountId = null;
        private static boolean sCheckRunning = false;
        private static String sCheckState = "";
        private static String sCheckText = "";
        private static String sCheckUrl = "";
        private static long sCheckStateAt = 0;

        private static synchronized void resetCheck() {
            sCheckState = "";
            sCheckText = "";
            sCheckUrl = "";
            sCheckStateAt = 0;
        }

        private static synchronized void recordCheck(String state, String text, String url) {
            if (!state.equals(sCheckState)) {
                sCheckState = state;
                sCheckStateAt = SystemClock.uptimeMillis();
            }
            sCheckText = text;
            sCheckUrl = url;
        }

        // Menerima laporan halaman dan permintaan bantuan login dari ekstensi limitwatch
        private static final WebExtension.MessageDelegate MESSAGE_DELEGATE =
                new WebExtension.MessageDelegate() {
                    @Override
                    public GeckoResult<Object> onMessage(String nativeApp, Object message,
                                                         WebExtension.MessageSender sender) {
                        GeckoResult<Object> out = null;
                        try {
                            if (message instanceof JSONObject) {
                                JSONObject msg = (JSONObject) message;
                                String type = msg.optString("type", "pageState");
                                if ("loginHelp".equals(type)) {
                                    // Email akun dan kode terbaru. Kosong saat pengecekan latar belakang,
                                    // supaya pengecekan tidak memicu email login.
                                    JSONObject o = new JSONObject();
                                    o.put("email", "");
                                    o.put("code", "");
                                    if (sCheckAccountId == null) {
                                        o.put("email", sCurrentEmail);
                                        String code = GeckoBrowser.takeCode();
                                        if (code != null) o.put("code", code);
                                    }
                                    out = new GeckoResult<>();
                                    out.complete(o);
                                } else {
                                    String state = msg.optString("state", "limit");
                                    String text = msg.optString("text", "");
                                    String url = msg.optString("url", "");
                                    if (sCheckAccountId != null) {
                                        recordCheck(state, text, url);
                                    } else if (!"limit".equals(state) || !text.isEmpty()) {
                                        GeckoBrowser.emit(sCurrentAccountId, state, text, url);
                                    }
                                }
                            }
                        } catch (Exception ignored) {
                        }
                        return out;
                    }
                };

        // Pasang ekstensi sekali, lalu jalankan r (di thread utama)
        private static void withExtension(final Runnable r) {
            if (sExtReady) {
                r.run();
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
                                r.run();
                            },
                            err -> r.run());
        }

        // Cek satu akun di sesi tersembunyi (tanpa layar). Satu pengecekan pada satu waktu.
        static void runCheck(final Context ctx, final String accountId, final String url,
                             final int timeoutMs, final CheckCallback cb) {
            final Handler h = new Handler(Looper.getMainLooper());
            h.post(new Runnable() {
                @Override
                public void run() {
                    if (sCheckRunning) {
                        JSObject busy = new JSObject();
                        busy.put("state", "unknown");
                        busy.put("error", "busy");
                        cb.done(busy);
                        return;
                    }
                    sCheckRunning = true;
                    resetCheck();
                    sCheckAccountId = accountId;
                    if (sRuntime == null) sRuntime = GeckoRuntime.create(ctx);

                    GeckoSessionSettings settings = new GeckoSessionSettings.Builder()
                            .contextId(accountId)
                            .build();
                    final GeckoSession s = new GeckoSession(settings);
                    s.open(sRuntime);
                    s.setActive(true);
                    withExtension(new Runnable() {
                        @Override
                        public void run() {
                            s.loadUri(url);
                        }
                    });

                    final long start = SystemClock.uptimeMillis();
                    h.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            long now = SystemClock.uptimeMillis();
                            String st;
                            long at;
                            synchronized (GeckoActivity.class) {
                                st = sCheckState;
                                at = sCheckStateAt;
                            }
                            // idle ditahan sebentar: banner limit bisa muncul sedikit setelah kolom chat siap
                            boolean conclusive = !st.isEmpty() && (!"idle".equals(st) || now - at >= 4500);
                            if (conclusive || now - start > timeoutMs) {
                                JSObject r = new JSObject();
                                synchronized (GeckoActivity.class) {
                                    r.put("state", sCheckState.isEmpty() ? "unknown" : sCheckState);
                                    r.put("text", sCheckText);
                                    r.put("url", sCheckUrl);
                                }
                                try {
                                    s.close();
                                } catch (Exception ignored) {
                                }
                                sCheckAccountId = null;
                                sCheckRunning = false;
                                cb.done(r);
                            } else {
                                h.postDelayed(this, 500);
                            }
                        }
                    }, 2000);
                }
            });
        }

        private GeckoSession session;
        private boolean canGoBack = false;

        @Override
        protected void onCreate(Bundle savedInstanceState) {
            super.onCreate(savedInstanceState);

            String accountId = getIntent().getStringExtra("accountId");
            String url = getIntent().getStringExtra("url");
            String email = getIntent().getStringExtra("email");
            if (accountId == null) accountId = "default";
            if (url == null) url = "https://claude.ai/new";
            sCurrentAccountId = accountId;
            sCurrentEmail = email == null ? "" : email;

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
            withExtension(new Runnable() {
                @Override
                public void run() {
                    if (session != null) session.loadUri(url);
                }
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
