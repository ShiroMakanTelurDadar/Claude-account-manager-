package com.local.claudeaccountmanager;

import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.DecelerateInterpolator;
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

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;

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

    // Jembatan JS -> native: open, check, takePending
    @CapacitorPlugin(name = "GeckoBrowser")
    public static class GeckoBrowser extends Plugin {
        private static GeckoBrowser sInstance;
        // Status halaman (limit / busy / reset / idle / loggedout) yang terdeteksi saat layar utama sedang di belakang browser.
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
            i.putExtra("email", call.getString("email", ""));
            i.putExtra("command", call.getString("command", ""));
            getActivity().startActivity(i);
            call.resolve();
        }

        // Simpan teks (backup) sebagai file di folder Download. Android 10+ tanpa izin tambahan.
        @PluginMethod
        public void saveFile(PluginCall call) {
            String name = call.getString("name", "backup.json");
            String content = call.getString("content", "");
            String mime = call.getString("mime", "application/json");
            try {
                byte[] data = content.getBytes(StandardCharsets.UTF_8);
                JSObject r = new JSObject();
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentResolver cr = getContext().getContentResolver();
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) { call.reject("Tidak bisa membuat file"); return; }
                    OutputStream os = cr.openOutputStream(uri);
                    if (os == null) { call.reject("Tidak bisa menulis file"); return; }
                    try { os.write(data); } finally { os.close(); }
                    r.put("where", "Download/" + name);
                } else {
                    // Android 9 ke bawah: folder khusus aplikasi (tanpa izin penyimpanan)
                    File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir == null) { call.reject("Penyimpanan tidak tersedia"); return; }
                    if (!dir.exists()) dir.mkdirs();
                    File f = new File(dir, name);
                    FileOutputStream os = new FileOutputStream(f);
                    try { os.write(data); } finally { os.close(); }
                    r.put("where", f.getAbsolutePath());
                }
                r.put("saved", true);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Gagal menyimpan: " + e.getMessage());
            }
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

        // Pancingan satu akun di sesi tersembunyi.
        // mode "send"  : buka chat baru, kirim ".", hentikan respon secepatnya, laporkan limit / free
        // mode "verify": buka chat pancingan (url), baca status limit di dalamnya, lalu hapus chat itu
        @PluginMethod
        public void bait(final PluginCall call) {
            final String accountId = call.getString("accountId", "default");
            final String url = call.getString("url", "https://claude.ai/new");
            final String rawMode = call.getString("mode", "send");
            final String mode = "verify".equals(rawMode) ? "verify" : "continue".equals(rawMode) ? "continue" : "send";
            // mode "continue": kirim Continue / command ke chat akun di sesi tersembunyi (tanpa membuka browser)
            final String command = call.getString("command", "");
            Integer t = call.getInt("timeoutMs", 85000);
            final int timeout = t == null ? 85000 : t;
            GeckoActivity.runBait(getContext().getApplicationContext(), accountId, url, mode, command, timeout,
                    new CheckCallback() {
                        @Override
                        public void done(JSObject res) {
                            call.resolve(res);
                        }
                    });
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

    // Layar browser (mesin Firefox). Tiap akun = contextId sendiri = cookie/login terpisah.
    public static class GeckoActivity extends Activity {
        private static final String EXT_URI = "resource://android/assets/public/limitwatch/";
        private static final String EXT_ID = "limitwatch@app.local";

        private static GeckoRuntime sRuntime;
        private static boolean sExtReady = false;
        private static volatile String sCurrentAccountId = "default";
        private static volatile String sCurrentEmail = "";
        // Command dari tombol Continue aplikasi. Dikirim ke chat oleh ekstensi, sekali saja (berlaku 3 menit).
        private static volatile String sPendingCommand = "";
        private static volatile long sPendingCommandAt = 0;

        // Pengecekan latar belakang: selama sCheckAccountId tidak null, laporan halaman dicatat di sini
        private static volatile String sCheckAccountId = null;
        private static boolean sCheckRunning = false;
        private static String sCheckState = "";
        private static String sCheckText = "";
        private static String sCheckUrl = "";
        private static long sCheckStateAt = 0;

        // Pancingan: mode sesi tersembunyi ("send" / "verify" / "") dan hasil yang dilaporkan halaman
        private static volatile String sBaitMode = "";
        private static volatile String sBaitCmd = "";   // command yang dikirim di mode "continue"
        private static boolean sBaitDone = false;
        private static String sBaitOutcome = "";
        private static String sBaitText = "";
        private static String sBaitUrl = "";
        private static boolean sBaitDeleted = false;

        // Refresh halaman sebelum dibaca (sesi latar belakang).
        // Halaman dimuat, lalu di-refresh (lewati cache) seperti tombol refresh di browser. Laporan halaman
        // sebelum refresh selesai dianggap basi dan dibuang.
        private static volatile boolean sReady = true;

        // Diagnosa: apa yang terjadi di sesi tersembunyi. Dikirim ke aplikasi supaya alasan gagal bisa dijelaskan.
        private static volatile String sExtInfo = "";        // hasil pemasangan ekstensi ("ok" atau pesan error)
        private static volatile int sPageStarts = 0;
        private static volatile int sPageStops = 0;
        private static volatile boolean sPageOk = false;
        private static volatile String sLastUrl = "";
        private static volatile boolean sHello = false;       // skrip ekstensi sudah melapor dari dalam halaman
        private static volatile String sHelloInfo = "";

        private static void resetDiag() {
            sPageStarts = 0;
            sPageStops = 0;
            sPageOk = false;
            sLastUrl = "";
            sHello = false;
            sHelloInfo = "";
        }

        private static String buildDiag() {
            String load = sPageStarts == 0 ? "tidak mulai" : sPageStops == 0 ? "belum selesai" : sPageOk ? "selesai" : "gagal";
            return "ext=" + (sExtInfo.isEmpty() ? "?" : sExtInfo)
                    + "; muat=" + load
                    + "; hello=" + (sHello ? sHelloInfo : "tidak")
                    + "; url=" + sLastUrl;
        }
        private static volatile long sReadyAt = 0;
        private static int sSessionSeq = 0;   // pewaktu lama dari sesi sebelumnya tidak boleh mengubah sesi yang sekarang

        private static void markReady() {
            resetCheck();
            sReadyAt = SystemClock.uptimeMillis();
            sReady = true;
        }

        // need = true: muat -> tunggu selesai -> refresh -> baru terima laporan. need = false: langsung terima laporan.
        private static void setupSession(final GeckoSession s, final Handler h, final boolean need) {
            if (!need) {
                sSessionSeq++;
                sReadyAt = SystemClock.uptimeMillis();
                sReady = true;
                s.setProgressDelegate(new GeckoSession.ProgressDelegate() {
                    @Override
                    public void onPageStop(GeckoSession session, boolean success) {
                        sPageStops++;
                        sPageOk = success;
                    }

                    @Override
                    public void onPageStart(GeckoSession session, String url) {
                        sPageStarts++;
                        sLastUrl = url == null ? "" : url;
                    }
                });
                return;
            }
            sReady = false;
            sReadyAt = 0;
            final int seq = ++sSessionSeq;
            final int[] stage = {0};   // 0 = muat awal, 1 = refresh diminta, 2 = halaman hasil refresh sudah mulai
            final Runnable doReload = new Runnable() {
                @Override
                public void run() {
                    if (seq != sSessionSeq || stage[0] != 0) return;
                    stage[0] = 1;
                    try {
                        s.reload(GeckoSession.LOAD_FLAGS_BYPASS_CACHE);
                    } catch (Exception e) {
                        stage[0] = 2;
                        markReady();
                        return;
                    }
                    // Cadangan: kalau awal muat ulang tidak terdeteksi, tetap mulai menerima laporan
                    h.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            if (seq == sSessionSeq && stage[0] != 2) {
                                stage[0] = 2;
                                markReady();
                            }
                        }
                    }, 5000);
                }
            };
            s.setProgressDelegate(new GeckoSession.ProgressDelegate() {
                @Override
                public void onPageStop(GeckoSession session, boolean success) {
                    sPageStops++;
                    sPageOk = success;
                    if (seq == sSessionSeq && stage[0] == 0) h.postDelayed(doReload, 1500);   // beri waktu halaman menampilkan isi awal
                }

                @Override
                public void onPageStart(GeckoSession session, String url) {
                    sPageStarts++;
                    sLastUrl = url == null ? "" : url;
                    if (seq == sSessionSeq && stage[0] == 1) {
                        stage[0] = 2;
                        markReady();
                    }
                }
            });
            // Cadangan: muat awal terlalu lama, refresh saja
            h.postDelayed(doReload, 12000);
        }

        private static synchronized void resetBait() {
            sBaitDone = false;
            sBaitOutcome = "";
            sBaitText = "";
            sBaitUrl = "";
            sBaitDeleted = false;
        }

        private static synchronized void recordBait(String outcome, String text, String url, boolean deleted) {
            sBaitOutcome = outcome;
            sBaitText = text;
            sBaitUrl = url;
            sBaitDeleted = deleted;
            sBaitDone = true;
        }

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

        // Menerima laporan halaman dan permintaan email login dari ekstensi limitwatch
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
                                    // Email akun untuk isi otomatis di halaman login. Kosong saat pengecekan latar belakang,
                                    // supaya pengecekan tidak memicu email login.
                                    JSONObject o = new JSONObject();
                                    o.put("email", sCheckAccountId == null ? sCurrentEmail : "");
                                    boolean cmdFresh = System.currentTimeMillis() - sPendingCommandAt < 180000L;
                                    o.put("command", sCheckAccountId == null && cmdFresh ? sPendingCommand : "");
                                    // Mode pancingan hanya berlaku di sesi latar belakang
                                    o.put("bait", sCheckAccountId == null || !sReady ? "" : sBaitMode);
                                    // Halaman belum di-refresh: content script diminta menunggu dan bertanya lagi
                                    o.put("wait", sCheckAccountId != null && !sReady);
                                    o.put("baitCmd", sCheckAccountId != null && sReady ? sBaitCmd : "");
                                    out = new GeckoResult<>();
                                    out.complete(o);
                                } else if ("hello".equals(type)) {
                                    sHello = true;
                                    String hu = msg.optString("url", "");
                                    String ht = msg.optString("title", "");
                                    if (hu.length() > 90) hu = hu.substring(0, 90);
                                    if (ht.length() > 60) ht = ht.substring(0, 60);
                                    sHelloInfo = hu + " | judul: " + ht + (msg.optBoolean("challenge", false) ? " | PEMERIKSAAN KEAMANAN" : "");
                                } else if ("commandDone".equals(type)) {
                                    sPendingCommand = "";
                                } else if ("baitResult".equals(type)) {
                                    if (sCheckAccountId != null && sReady && !sBaitMode.isEmpty()) {
                                        recordBait(msg.optString("outcome", "fail"),
                                                msg.optString("text", ""),
                                                msg.optString("url", ""),
                                                msg.optBoolean("deleted", false));
                                    }
                                } else {
                                    String state = msg.optString("state", "limit");
                                    String text = msg.optString("text", "");
                                    String url = msg.optString("url", "");
                                    if (sCheckAccountId != null) {
                                        if (sReady) recordCheck(state, text, url);   // sebelum refresh = basi, dibuang
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
                                    sExtInfo = "ok";
                                } else {
                                    sExtInfo = "gagal dipasang (kosong)";
                                }
                                r.run();
                            },
                            err -> {
                                sExtInfo = "gagal dipasang: " + String.valueOf(err);
                                r.run();
                            });
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
                    resetDiag();
                    sBaitMode = "";   // pengecekan biasa
                    sCheckAccountId = accountId;
                    if (sRuntime == null) sRuntime = GeckoRuntime.create(ctx);

                    GeckoSessionSettings settings = new GeckoSessionSettings.Builder()
                            .contextId(accountId)
                            .build();
                    final GeckoSession s = new GeckoSession(settings);
                    setupSession(s, h, true);   // muat, refresh, baru baca
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
                            // Batas waktu dihitung sejak halaman di-refresh; batas total mencegah menggantung
                            long base = sReadyAt > 0 ? sReadyAt : start;
                            boolean expired = now - base > timeoutMs || now - start > timeoutMs + 25000L;
                            String st;
                            long at;
                            synchronized (GeckoActivity.class) {
                                st = sCheckState;
                                at = sCheckStateAt;
                            }
                            // idle ditahan sebentar: banner limit bisa muncul sedikit setelah kolom chat siap
                            boolean conclusive = !st.isEmpty() && (!"idle".equals(st) || now - at >= 4500);
                            if (conclusive || expired) {
                                JSObject r = new JSObject();
                                synchronized (GeckoActivity.class) {
                                    r.put("state", sCheckState.isEmpty() ? "unknown" : sCheckState);
                                    r.put("text", sCheckText);
                                    r.put("url", sCheckUrl);
                                }
                                r.put("diag", buildDiag());
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

        // Pancingan satu akun di sesi tersembunyi. Memakai kunci yang sama dengan runCheck (satu sesi latar belakang pada satu waktu).
        // Sesi ditutup segera setelah halaman melapor, jadi respon Claude tidak sempat berjalan.
        static void runBait(final Context ctx, final String accountId, final String url,
                            final String mode, final String command, final int timeoutMs, final CheckCallback cb) {
            final Handler h = new Handler(Looper.getMainLooper());
            h.post(new Runnable() {
                @Override
                public void run() {
                    if (sCheckRunning) {
                        JSObject busy = new JSObject();
                        busy.put("state", "fail");
                        busy.put("error", "busy");
                        cb.done(busy);
                        return;
                    }
                    sCheckRunning = true;
                    resetCheck();
                    resetBait();
                    resetDiag();
                    sCheckAccountId = accountId;
                    sBaitMode = mode;
                    sBaitCmd = command == null ? "" : command;
                    if (sRuntime == null) sRuntime = GeckoRuntime.create(ctx);

                    GeckoSessionSettings settings = new GeckoSessionSettings.Builder()
                            .contextId(accountId)
                            .build();
                    final GeckoSession s = new GeckoSession(settings);
                    // verify / continue: halaman di-refresh dulu sebelum dibaca atau dikirimi pesan. send: chat baru, tidak perlu.
                    setupSession(s, h, !"send".equals(mode));
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
                            long base = sReadyAt > 0 ? sReadyAt : start;
                            boolean expired = now - base > timeoutMs || now - start > timeoutMs + 25000L;
                            boolean done;
                            synchronized (GeckoActivity.class) {
                                done = sBaitDone;
                            }
                            if (done || expired) {
                                JSObject r = new JSObject();
                                synchronized (GeckoActivity.class) {
                                    r.put("state", sBaitDone ? sBaitOutcome : "fail");
                                    r.put("text", sBaitDone ? sBaitText : "why:timeout");
                                    r.put("url", sBaitUrl);
                                    r.put("deleted", sBaitDeleted);
                                }
                                r.put("diag", buildDiag());
                                try {
                                    s.close();
                                } catch (Exception ignored) {
                                }
                                sBaitMode = "";
                                sBaitCmd = "";
                                sCheckAccountId = null;
                                sCheckRunning = false;
                                cb.done(r);
                            } else {
                                h.postDelayed(this, 100);
                            }
                        }
                    }, 1000);
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
            String command = getIntent().getStringExtra("command");
            sPendingCommand = command == null ? "" : command;
            sPendingCommandAt = System.currentTimeMillis();

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
            setContentView(root);
            buildFloatingMenu(root);

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

        // ===== Tombol melayang gabungan (gaya AssistiveTouch iPhone) =====
        // Satu tombol bulat kecil. Diketuk -> muncul tombol Home dan Refresh di sebelahnya.
        // Bisa digeser ke mana saja dan menempel ke tepi kiri/kanan saat dilepas (posisi diingat).
        // Kalau lama tidak disentuh, warnanya memudar jadi abu-abu (saturasi turun) dan agak transparan.
        private static final long FAB_IDLE_MS = 3000L;    // diam selama ini -> saturasi turun
        private static final long FAB_MENU_MS = 4500L;    // menu terbuka tanpa disentuh -> menutup sendiri
        private static final float FAB_IDLE_SAT = 0.1f;   // 1 = warna penuh, 0 = abu-abu
        private static final float FAB_IDLE_ALPHA = 0.6f;

        private BubbleView fab;
        private TextView fabHome, fabRefresh;
        private boolean fabOpen = false;
        private float fabSat = 1f;
        private ValueAnimator satAnim;
        private final Handler fabH = new Handler(Looper.getMainLooper());
        private final Runnable fabIdle = new Runnable() {
            @Override
            public void run() {
                if (fab == null) return;
                if (fabOpen) {
                    closeFabMenu();
                    scheduleFabIdle(FAB_IDLE_MS);
                    return;
                }
                animateFabSat(FAB_IDLE_SAT);
                fab.animate().alpha(FAB_IDLE_ALPHA).setDuration(600).start();
            }
        };

        // Tombol utama: kotak membulat gelap + cincin biru langit. Warna biru hilang saat saturasi diturunkan.
        private static class BubbleView extends View {
            private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
            private final Paint edge = new Paint(Paint.ANTI_ALIAS_FLAG);
            private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
            private final Paint dot = new Paint(Paint.ANTI_ALIAS_FLAG);
            private final Paint layer = new Paint();
            private final ColorMatrix cm = new ColorMatrix();
            private final RectF rect = new RectF();

            BubbleView(Context c) {
                super(c);
                float d = c.getResources().getDisplayMetrics().density;
                fill.setStyle(Paint.Style.FILL);
                fill.setColor(0xE6071524);
                edge.setStyle(Paint.Style.STROKE);
                edge.setStrokeWidth(1.2f * d);
                edge.setColor(0x887DD3FC);
                ring.setStyle(Paint.Style.STROKE);
                ring.setStrokeWidth(2f * d);
                ring.setColor(0xFF7DD3FC);
                dot.setStyle(Paint.Style.FILL);
                dot.setColor(0xFFBAE6FD);
                setLayerType(LAYER_TYPE_HARDWARE, layer);
            }

            void setSaturation(float s) {
                cm.setSaturation(s);
                layer.setColorFilter(new ColorMatrixColorFilter(cm));
                setLayerPaint(layer);
            }

            @Override
            protected void onDraw(Canvas canvas) {
                float w = getWidth(), h = getHeight();
                float inset = edge.getStrokeWidth();
                rect.set(inset, inset, w - inset, h - inset);
                float r = Math.min(w, h) * 0.32f;
                canvas.drawRoundRect(rect, r, r, fill);
                canvas.drawRoundRect(rect, r, r, edge);
                canvas.drawCircle(w / 2f, h / 2f, Math.min(w, h) * 0.26f, ring);
                canvas.drawCircle(w / 2f, h / 2f, Math.min(w, h) * 0.09f, dot);
            }
        }

        private TextView buildFabAction(String glyph, String desc, float textSize, int sizePx) {
            float d = getResources().getDisplayMetrics().density;
            TextView b = new TextView(this);
            b.setText(glyph);
            b.setTextSize(textSize);
            b.setTextColor(Color.WHITE);
            b.setGravity(Gravity.CENTER);
            b.setElevation(10 * d);
            GradientDrawable bg = new GradientDrawable();
            bg.setShape(GradientDrawable.OVAL);
            bg.setColor(0xE6071524);
            bg.setStroke((int) (1 * d), 0x887DD3FC);
            b.setBackground(bg);
            b.setContentDescription(desc);
            b.setVisibility(View.GONE);
            b.setLayoutParams(new FrameLayout.LayoutParams(sizePx, sizePx));
            return b;
        }

        private void buildFloatingMenu(final FrameLayout root) {
            final float d = getResources().getDisplayMetrics().density;
            final int fabSize = (int) (48 * d);
            final int btnSize = (int) (44 * d);

            fabHome = buildFabAction("⌂", "Kembali ke beranda aplikasi", 22f, btnSize);
            fabHome.setOnClickListener(v -> finish());

            fabRefresh = buildFabAction("↻", "Muat ulang halaman", 20f, btnSize);
            fabRefresh.setOnClickListener(v -> {
                if (session != null) session.reload();
                scheduleFabIdle(FAB_IDLE_MS);
                // Putar sekali sebagai tanda, lalu menu menutup
                fabRefresh.animate().rotationBy(360f).setDuration(400).withEndAction(new Runnable() {
                    @Override
                    public void run() {
                        fabRefresh.setRotation(0f);
                        closeFabMenu();
                    }
                }).start();
            });

            fab = new BubbleView(this);
            fab.setElevation(12 * d);
            fab.setContentDescription("Menu melayang: beranda dan muat ulang");
            fab.setLayoutParams(new FrameLayout.LayoutParams(fabSize, fabSize));

            root.addView(fabHome);
            root.addView(fabRefresh);
            root.addView(fab);   // paling atas

            fab.setOnTouchListener(new View.OnTouchListener() {
                private float downX, downY, startX, startY;
                private boolean moved;

                @Override
                public boolean onTouch(View v, MotionEvent e) {
                    View parent = (View) v.getParent();
                    switch (e.getActionMasked()) {
                        case MotionEvent.ACTION_DOWN:
                            wakeFab();
                            v.animate().cancel();
                            downX = e.getRawX();
                            downY = e.getRawY();
                            startX = v.getX();
                            startY = v.getY();
                            moved = false;
                            return true;
                        case MotionEvent.ACTION_MOVE: {
                            float dx = e.getRawX() - downX;
                            float dy = e.getRawY() - downY;
                            if (!moved && Math.abs(dx) + Math.abs(dy) > 10 * d) {
                                moved = true;
                                if (fabOpen) closeFabMenu();
                            }
                            if (moved && parent != null) {
                                float nx = Math.max(0, Math.min(parent.getWidth() - v.getWidth(), startX + dx));
                                float ny = Math.max(0, Math.min(parent.getHeight() - v.getHeight(), startY + dy));
                                v.setX(nx);
                                v.setY(ny);
                            }
                            return true;
                        }
                        case MotionEvent.ACTION_UP:
                            if (moved) snapFab();
                            else toggleFabMenu();
                            scheduleFabIdle(fabOpen ? FAB_MENU_MS : FAB_IDLE_MS);
                            return true;
                        case MotionEvent.ACTION_CANCEL:
                            if (moved) snapFab();
                            scheduleFabIdle(FAB_IDLE_MS);
                            return true;
                        default:
                            return false;
                    }
                }
            });

            // Posisi awal: dari yang tersimpan (tepi kiri/kanan + tinggi). Menunggu layout pertama selesai,
            // karena sebelum itu lebar/tinggi layar masih 0.
            root.addOnLayoutChangeListener(new View.OnLayoutChangeListener() {
                @Override
                public void onLayoutChange(View v, int l, int t, int r, int b, int oldL, int oldT, int oldR, int oldB) {
                    if (r - l > 0 && b - t > 0 && fab != null && fab.getWidth() > 0) {
                        root.removeOnLayoutChangeListener(this);
                        placeFab();
                        scheduleFabIdle(FAB_IDLE_MS);
                    }
                }
            });
        }

        private void placeFab() {
            if (fab == null) return;
            View parent = (View) fab.getParent();
            if (parent == null || parent.getWidth() == 0) return;
            float d = getResources().getDisplayMetrics().density;
            SharedPreferences sp = getSharedPreferences("floating_menu", Context.MODE_PRIVATE);
            boolean right = sp.getBoolean("right", false);
            float yf = sp.getFloat("y", 0.5f);
            float margin = 4 * d;
            float x = right ? parent.getWidth() - fab.getWidth() - margin : margin;
            float y = Math.max(0, Math.min(parent.getHeight() - fab.getHeight(), yf * parent.getHeight() - fab.getHeight() / 2f));
            fab.setX(x);
            fab.setY(y);
        }

        // Setelah digeser: menempel ke tepi terdekat (kiri atau kanan) dan menyimpan posisinya
        private void snapFab() {
            if (fab == null) return;
            View parent = (View) fab.getParent();
            if (parent == null) return;
            float d = getResources().getDisplayMetrics().density;
            float margin = 4 * d;
            boolean right = fab.getX() + fab.getWidth() / 2f > parent.getWidth() / 2f;
            float tx = right ? parent.getWidth() - fab.getWidth() - margin : margin;
            fab.animate().x(tx).setDuration(220).setInterpolator(new DecelerateInterpolator()).start();
            float yf = parent.getHeight() > 0 ? (fab.getY() + fab.getHeight() / 2f) / parent.getHeight() : 0.5f;
            getSharedPreferences("floating_menu", Context.MODE_PRIVATE).edit()
                    .putBoolean("right", right).putFloat("y", yf).apply();
        }

        private void scheduleFabIdle(long ms) {
            fabH.removeCallbacks(fabIdle);
            fabH.postDelayed(fabIdle, ms);
        }

        // Disentuh: warna kembali penuh dan tidak transparan
        private void wakeFab() {
            fabH.removeCallbacks(fabIdle);
            animateFabSat(1f);
            if (fab != null) fab.animate().alpha(1f).setDuration(150).start();
        }

        private void animateFabSat(float to) {
            if (fab == null) return;
            if (satAnim != null) satAnim.cancel();
            if (Math.abs(fabSat - to) < 0.001f) return;
            satAnim = ValueAnimator.ofFloat(fabSat, to);
            satAnim.setDuration(to > fabSat ? 150 : 900);
            satAnim.addUpdateListener(new ValueAnimator.AnimatorUpdateListener() {
                @Override
                public void onAnimationUpdate(ValueAnimator a) {
                    fabSat = (Float) a.getAnimatedValue();
                    if (fab != null) fab.setSaturation(fabSat);
                }
            });
            satAnim.start();
        }

        private void toggleFabMenu() {
            if (fabOpen) closeFabMenu();
            else openFabMenu();
        }

        // Tombol Home dan Refresh keluar di samping tombol utama, ke sisi yang lebih lapang
        private void openFabMenu() {
            if (fabOpen || fab == null) return;
            View parent = (View) fab.getParent();
            if (parent == null) return;
            float d = getResources().getDisplayMetrics().density;
            float gap = 8 * d;
            float bs = fabHome.getLayoutParams().width;
            boolean toRight = fab.getX() + fab.getWidth() / 2f < parent.getWidth() / 2f;
            float cy = fab.getY() + (fab.getHeight() - bs) / 2f;
            float fromX = fab.getX() + (fab.getWidth() - bs) / 2f;
            float x1 = toRight ? fab.getX() + fab.getWidth() + gap : fab.getX() - gap - bs;
            float x2 = toRight ? x1 + bs + gap : x1 - bs - gap;
            float maxX = parent.getWidth() - bs;
            x1 = Math.max(0, Math.min(maxX, x1));
            x2 = Math.max(0, Math.min(maxX, x2));
            fabOpen = true;
            showFabAction(fabHome, fromX, x1, cy, 0);
            showFabAction(fabRefresh, fromX, x2, cy, 50);
        }

        private void showFabAction(TextView b, float fromX, float toX, float y, long delay) {
            b.animate().cancel();
            b.setX(fromX);
            b.setY(y);
            b.setAlpha(0f);
            b.setScaleX(0.4f);
            b.setScaleY(0.4f);
            b.setVisibility(View.VISIBLE);
            b.animate().x(toX).alpha(1f).scaleX(1f).scaleY(1f).setStartDelay(delay).setDuration(200)
                    .setInterpolator(new DecelerateInterpolator()).start();
        }

        private void closeFabMenu() {
            if (!fabOpen || fab == null) return;
            fabOpen = false;
            float toX = fab.getX() + (fab.getWidth() - fabHome.getLayoutParams().width) / 2f;
            hideFabAction(fabHome, toX, 0);
            hideFabAction(fabRefresh, toX, 30);
        }

        private void hideFabAction(final TextView b, float toX, long delay) {
            b.animate().cancel();
            b.animate().x(toX).alpha(0f).scaleX(0.4f).scaleY(0.4f).setStartDelay(delay).setDuration(160)
                    .withEndAction(new Runnable() {
                        @Override
                        public void run() {
                            if (!fabOpen) b.setVisibility(View.GONE);
                        }
                    }).start();
        }

        @Override
        public void onBackPressed() {
            if (fabOpen) {
                closeFabMenu();
            } else if (canGoBack && session != null) {
                session.goBack();
            } else {
                finish();
            }
        }

        @Override
        protected void onDestroy() {
            fabH.removeCallbacksAndMessages(null);
            if (satAnim != null) satAnim.cancel();
            if (session != null) {
                session.close();
                session = null;
            }
            super.onDestroy();
        }
    }
}
