package com.local.claudeaccountmanager;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
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
                    if (seq == sSessionSeq && stage[0] == 0) h.postDelayed(doReload, 1500);   // beri waktu halaman menampilkan isi awal
                }

                @Override
                public void onPageStart(GeckoSession session, String url) {
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
            root.addView(buildHomeButton(), homeButtonParams());
            root.addView(buildRefreshButton(), refreshButtonParams());
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

        // Tombol refresh melayang. Saat tidak dipakai pudar (kontras rendah), bisa digeser ke mana saja.
        private TextView buildRefreshButton() {
            final float d = getResources().getDisplayMetrics().density;
            final float idleAlpha = 0.3f;
            final Handler h = new Handler(Looper.getMainLooper());
            final TextView b = new TextView(this);
            b.setText("↻");
            b.setTextSize(20f);
            b.setTextColor(0xFFB8C4D0);
            b.setGravity(Gravity.CENTER);
            b.setAlpha(idleAlpha);
            b.setElevation(8 * d);
            GradientDrawable bg = new GradientDrawable();
            bg.setShape(GradientDrawable.OVAL);
            bg.setColor(0xAA2A3340);
            bg.setStroke((int) (1 * d), 0x449AA7B5);
            b.setBackground(bg);
            b.setContentDescription("Muat ulang halaman");
            final Runnable fade = new Runnable() {
                @Override
                public void run() {
                    b.animate().alpha(idleAlpha).setDuration(400).start();
                }
            };
            b.setOnTouchListener(new View.OnTouchListener() {
                private float downX, downY, startX, startY;
                private boolean moved;

                @Override
                public boolean onTouch(View v, MotionEvent e) {
                    View parent = (View) v.getParent();
                    switch (e.getActionMasked()) {
                        case MotionEvent.ACTION_DOWN:
                            h.removeCallbacks(fade);
                            v.animate().cancel();
                            v.setAlpha(0.9f);
                            downX = e.getRawX();
                            downY = e.getRawY();
                            startX = v.getX();
                            startY = v.getY();
                            moved = false;
                            return true;
                        case MotionEvent.ACTION_MOVE: {
                            float dx = e.getRawX() - downX;
                            float dy = e.getRawY() - downY;
                            if (!moved && Math.abs(dx) + Math.abs(dy) > 10 * d) moved = true;
                            if (moved && parent != null) {
                                float nx = Math.max(0, Math.min(parent.getWidth() - v.getWidth(), startX + dx));
                                float ny = Math.max(0, Math.min(parent.getHeight() - v.getHeight(), startY + dy));
                                v.setX(nx);
                                v.setY(ny);
                            }
                            return true;
                        }
                        case MotionEvent.ACTION_UP:
                            if (!moved && session != null) session.reload();
                            h.postDelayed(fade, 2500);
                            return true;
                        case MotionEvent.ACTION_CANCEL:
                            h.postDelayed(fade, 2500);
                            return true;
                        default:
                            return false;
                    }
                }
            });
            return b;
        }

        private FrameLayout.LayoutParams refreshButtonParams() {
            float d = getResources().getDisplayMetrics().density;
            int size = (int) (40 * d);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                    size, size, Gravity.START | Gravity.CENTER_VERTICAL);
            lp.leftMargin = (int) (8 * d);
            lp.topMargin = (int) (96 * d);
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
