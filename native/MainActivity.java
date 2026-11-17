package com.local.claudeaccountmanager;

import android.app.Activity;
import android.app.Notification;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.app.NotificationManagerCompat;

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
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

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

        // Dipanggil dari MailCodeListener saat kode login terbaca dari notifikasi email
        static void emitCode(String code, String email, long at) {
            if (sInstance == null) return;
            JSObject data = new JSObject();
            data.put("code", code);
            data.put("email", email);
            data.put("at", at);
            sInstance.notifyListeners("mailCode", data);
        }

        // Cek apakah akses notifikasi untuk aplikasi ini sudah diaktifkan
        @PluginMethod
        public void isListenerEnabled(PluginCall call) {
            Set<String> pk = NotificationManagerCompat.getEnabledListenerPackages(getContext());
            JSObject res = new JSObject();
            res.put("enabled", pk.contains(getContext().getPackageName()));
            call.resolve(res);
        }

        // Buka layar pengaturan "Akses notifikasi"
        @PluginMethod
        public void openListenerSettings(PluginCall call) {
            try {
                Intent i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(i);
                call.resolve();
            } catch (Exception e) {
                call.reject("Tidak bisa membuka pengaturan akses notifikasi");
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
                                // Content script meminta kode login terakhir dari email
                                if ("getCode".equals(msg.optString("type"))) {
                                    JSONObject out = new JSONObject();
                                    long age = System.currentTimeMillis() - MailCodeListener.sCodeAt;
                                    if (!MailCodeListener.sCode.isEmpty() && age < MailCodeListener.CODE_TTL) {
                                        out.put("code", MailCodeListener.sCode);
                                        out.put("at", MailCodeListener.sCodeAt);
                                    }
                                    return GeckoResult.<Object>fromValue(out);
                                }
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

    // Membaca notifikasi email masuk (Gmail dll). Kalau isinya kode login Claude:
    // kode disalin ke clipboard otomatis dan disimpan supaya halaman login bisa menempelkannya.
    // Perlu izin: Pengaturan > Akses notifikasi > Claude Account Manager.
    public static class MailCodeListener extends NotificationListenerService {
        // Kode dicari dulu setelah kata "code"/"kode", kalau tidak ada: angka 6 digit yang berdiri sendiri.
        // Kalau format kode dari Claude berubah, sesuaikan dua pola ini.
        private static final Pattern CODE_KEYED = Pattern.compile(
                "(?:code|kode)[^0-9]{0,40}?(?<![0-9])([0-9]{4,8})(?![0-9])", Pattern.CASE_INSENSITIVE);
        private static final Pattern CODE_ANY = Pattern.compile("(?<![0-9])([0-9]{6})(?![0-9])");

        static final long CODE_TTL = 10 * 60 * 1000L;
        static volatile String sCode = "";
        static volatile String sEmail = "";
        static volatile long sCodeAt = 0;

        @Override
        public void onNotificationPosted(StatusBarNotification sbn) {
            try {
                handle(sbn);
            } catch (Exception ignored) {
            }
        }

        private void handle(StatusBarNotification sbn) {
            if (sbn == null || getPackageName().equals(sbn.getPackageName())) return;
            Notification n = sbn.getNotification();
            if (n == null || n.extras == null) return;
            Bundle ex = n.extras;

            StringBuilder sb = new StringBuilder();
            add(sb, ex.getCharSequence(Notification.EXTRA_TITLE));
            add(sb, ex.getCharSequence(Notification.EXTRA_TEXT));
            add(sb, ex.getCharSequence(Notification.EXTRA_BIG_TEXT));
            add(sb, ex.getCharSequence(Notification.EXTRA_SUMMARY_TEXT));
            CharSequence[] lines = ex.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
            if (lines != null) for (CharSequence l : lines) add(sb, l);
            add(sb, n.tickerText);
            String all = sb.toString();

            String low = all.toLowerCase();
            if (!low.contains("claude") && !low.contains("anthropic")) return;
            String code = extractCode(all);
            if (code == null) return;

            long now = System.currentTimeMillis();
            // Gmail sering memperbarui notifikasi yang sama berkali-kali
            if (code.equals(sCode) && now - sCodeAt < 30000) return;

            // Gmail mengisi sub text dengan alamat akun penerima
            CharSequence sub = ex.getCharSequence(Notification.EXTRA_SUB_TEXT);
            String email = (sub != null && sub.toString().contains("@")) ? sub.toString() : "";

            sCode = code;
            sEmail = email;
            sCodeAt = now;

            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Kode login Claude", code));
            Toast.makeText(getApplicationContext(), "Kode Claude " + code + " disalin", Toast.LENGTH_LONG).show();
            GeckoBrowser.emitCode(code, email, now);
        }

        private static void add(StringBuilder sb, CharSequence cs) {
            if (cs != null && cs.length() > 0) sb.append(cs).append('\n');
        }

        private static String extractCode(String text) {
            Matcher m = CODE_KEYED.matcher(text);
            if (m.find()) return m.group(1);
            m = CODE_ANY.matcher(text);
            if (m.find()) return m.group(1);
            return null;
        }
    }
}
