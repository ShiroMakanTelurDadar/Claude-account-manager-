package com.local.claudeaccountmanager;

import android.animation.ValueAnimator;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
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
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Locale;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GeckoBrowser.class);
        super.onCreate(savedInstanceState);
        sActivityAlive = true;
    }

    @Override
    public void onDestroy() {
        sActivityAlive = false;
        super.onDestroy();
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
            GeckoActivity.sHost = new WeakReference<>(getActivity());
        }

        @Override
        protected void handleOnResume() {
            super.handleOnResume();
            GeckoActivity.sHost = new WeakReference<>(getActivity());
            GeckoActivity.sHostVisible = true;
        }

        @Override
        protected void handleOnPause() {
            super.handleOnPause();
            GeckoActivity.sHostVisible = false;
        }

        // Layanan latar depan: menjaga proses aplikasi tetap hidup supaya cek otomatis dan pancingan jalan walau layar mati / aplikasi diminimalkan
        @PluginMethod
        public void keepAlive(PluginCall call) {
            boolean on = call.getBoolean("on", true);
            try {
                Intent i = new Intent(getContext(), KeepAliveService.class);
                if (on) {
                    if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i);
                    else getContext().startService(i);
                } else {
                    getContext().stopService(i);
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("keepAlive gagal: " + e.getMessage());
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

        // Batalkan pengecekan / pancingan yang sedang berjalan (sesi tersembunyi ditutup di putaran polling berikutnya)
        @PluginMethod
        public void cancelCheck(final PluginCall call) {
            GeckoActivity.sCancel = true;
            call.resolve();
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

        // ---- Cek saat aplikasi ditutup (lihat BgScheduler) ----
        // JS mengirim pengaturan jadwal + daftar akun. Native memasang alarm sistem dari situ.
        @PluginMethod
        public void bgConfigure(PluginCall call) {
            try {
                Context c = getContext().getApplicationContext();
                JSONObject cfg = BgStore.cfg(c);
                JSObject d = call.getData();
                cfg.put("on", d.optBoolean("on", false));
                cfg.put("autoMin", d.optInt("autoMin", 0));
                cfg.put("quietOn", d.optBoolean("quietOn", false));
                cfg.put("quietStart", d.optString("quietStart", "01:00"));
                cfg.put("quietEnd", d.optString("quietEnd", "05:00"));
                // Yang lebih baru menang: native bisa sudah mengecek saat aplikasi tertutup
                cfg.put("lastAuto", Math.max(cfg.optLong("lastAuto", 0), d.optLong("lastAuto", 0)));
                String ed = d.optString("quietEndDay", "");
                if (ed.compareTo(cfg.optString("quietEndDay", "")) > 0) cfg.put("quietEndDay", ed);
                String pd = d.optString("quietPreDay", "");
                if (pd.compareTo(cfg.optString("quietPreDay", "")) > 0) cfg.put("quietPreDay", pd);
                JSONArray accts = d.optJSONArray("accounts");
                cfg.put("accounts", accts == null ? new JSONArray() : accts);
                BgStore.putCfg(c, cfg);
                BgScheduler.schedule(c);
                call.resolve();
            } catch (Exception e) {
                call.reject("bgConfigure gagal: " + e.getMessage());
            }
        }

        // Ambil hasil cek yang dijalankan native saat aplikasi tertutup (sekali ambil, lalu dikosongkan)
        @PluginMethod
        public void bgTake(PluginCall call) {
            Context c = getContext().getApplicationContext();
            JSONObject cfg = BgStore.cfg(c);
            JSObject r = new JSObject();
            r.put("runs", BgStore.takeRuns(c));
            r.put("lastAuto", cfg.optLong("lastAuto", 0));
            r.put("quietEndDay", cfg.optString("quietEndDay", ""));
            r.put("quietPreDay", cfg.optString("quietPreDay", ""));
            call.resolve(r);
        }

        // Status izin yang dibutuhkan cek saat aplikasi tertutup
        @PluginMethod
        public void bgStatus(PluginCall call) {
            Context c = getContext().getApplicationContext();
            JSObject r = new JSObject();
            boolean overlay = Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(c);
            boolean battery = true;
            boolean exact = true;
            try {
                PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
                if (Build.VERSION.SDK_INT >= 23 && pm != null) battery = pm.isIgnoringBatteryOptimizations(c.getPackageName());
                AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
                if (Build.VERSION.SDK_INT >= 31 && am != null) exact = am.canScheduleExactAlarms();
            } catch (Exception ignored) {
            }
            r.put("overlay", overlay);
            r.put("battery", battery);
            r.put("exact", exact);
            r.put("next", BgScheduler.nextTrigger(BgStore.cfg(c), System.currentTimeMillis()));
            call.resolve(r);
        }

        // Buka layar pengaturan izin: overlay, battery, exact
        @PluginMethod
        public void bgOpen(PluginCall call) {
            String what = call.getString("what", "overlay");
            Context c = getContext();
            Uri pkg = Uri.parse("package:" + c.getPackageName());
            try {
                Intent i;
                if ("overlay".equals(what)) i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkg);
                else if ("battery".equals(what)) i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg);
                else if ("exact".equals(what) && Build.VERSION.SDK_INT >= 31) i = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkg);
                else i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                c.startActivity(i);
                call.resolve();
            } catch (Exception e) {
                try {
                    Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    c.startActivity(i);
                    call.resolve();
                } catch (Exception e2) {
                    call.reject("Tidak bisa membuka pengaturan: " + e2.getMessage());
                }
            }
        }

        // Uji: jalankan pengecekan native 20 detik lagi (aplikasi boleh ditutup sekarang)
        @PluginMethod
        public void bgTest(PluginCall call) {
            BgScheduler.armAt(getContext().getApplicationContext(), System.currentTimeMillis() + 20000L, "Uji");
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

    // Layanan latar depan: hanya menahan proses tetap hidup (notifikasi kecil + kunci CPU). Logika cek tetap di aplikasi.
    public static class KeepAliveService extends Service {
        private PowerManager.WakeLock wake;

        @Override
        public IBinder onBind(Intent intent) {
            return null;
        }

        @Override
        public int onStartCommand(Intent intent, int flags, int startId) {
            try {
                final String ch = "keepalive";
                if (Build.VERSION.SDK_INT >= 26) {
                    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                    if (nm != null) nm.createNotificationChannel(new NotificationChannel(ch, "Pengecekan latar belakang", NotificationManager.IMPORTANCE_LOW));
                }
                Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, ch) : new Notification.Builder(this);
                b.setContentTitle("Account Manager")
                        .setContentText("Cek otomatis dan pancingan berjalan di latar belakang")
                        .setSmallIcon(android.R.drawable.stat_notify_sync)
                        .setOngoing(true);
                Notification n = b.build();
                if (Build.VERSION.SDK_INT >= 29) startForeground(7101, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                else startForeground(7101, n);
                if (wake == null) {
                    PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                    if (pm != null) {
                        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "claudeaccountmanager:keepalive");
                        wake.setReferenceCounted(false);
                        wake.acquire();
                    }
                }
            } catch (Exception ignored) {
            }
            return START_STICKY;
        }

        @Override
        public void onDestroy() {
            try {
                if (wake != null && wake.isHeld()) wake.release();
            } catch (Exception ignored) {
            }
            wake = null;
            super.onDestroy();
        }
    }

    // ======== Cek otomatis saat aplikasi ditutup ========
    // Jadwal (berkala, sebelum dan sesudah jam tenang) dihitung di sini, bukan di halaman aplikasi (WebView), karena halaman itu mati
    // begitu aplikasi ditutup. Aplikasi mengirim salinan pengaturan + daftar akun lewat bgConfigure. Alarm sistem membangunkan BgReceiver,
    // lalu BgCheckService mengecek akun yang belum Limit satu per satu di sesi tersembunyi. Hasil disimpan dan diambil aplikasi
    // saat dibuka lagi (bgTake). Kalau aplikasi sedang hidup (sActivityAlive), jadwal dijalankan oleh aplikasi sendiri dan native diam.
    static volatile boolean sActivityAlive = false;

    public static class BgStore {
        static SharedPreferences sp(Context c) {
            return c.getSharedPreferences("bgcheck", Context.MODE_PRIVATE);
        }

        static synchronized JSONObject cfg(Context c) {
            try {
                return new JSONObject(sp(c).getString("cfg", "{}"));
            } catch (Exception e) {
                return new JSONObject();
            }
        }

        static synchronized void putCfg(Context c, JSONObject o) {
            sp(c).edit().putString("cfg", o.toString()).apply();
        }

        static synchronized JSONArray runs(Context c) {
            try {
                return new JSONArray(sp(c).getString("runs", "[]"));
            } catch (Exception e) {
                return new JSONArray();
            }
        }

        static synchronized void addRun(Context c, JSONObject run) {
            try {
                JSONArray old = runs(c);
                JSONArray n = new JSONArray();
                for (int i = Math.max(0, old.length() - 29); i < old.length(); i++) n.put(old.get(i));
                n.put(run);
                sp(c).edit().putString("runs", n.toString()).apply();
            } catch (Exception ignored) {
            }
        }

        static synchronized JSONArray takeRuns(Context c) {
            JSONArray r = runs(c);
            sp(c).edit().putString("runs", "[]").apply();
            return r;
        }
    }

    public static class BgScheduler {
        static final String ACTION_RUN = "com.local.claudeaccountmanager.BG_RUN";

        static int mins(String hhmm) {
            try {
                String[] p = hhmm.split(":");
                return Integer.parseInt(p[0]) * 60 + Integer.parseInt(p[1]);
            } catch (Exception e) {
                return 0;
            }
        }

        static int minOfDay(long ms) {
            Calendar c = Calendar.getInstance();
            c.setTimeInMillis(ms);
            return c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE);
        }

        static String dayKey(long ms) {
            Calendar c = Calendar.getInstance();
            c.setTimeInMillis(ms);
            return String.format(Locale.US, "%04d-%02d-%02d", c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
        }

        static boolean quietOn(JSONObject cfg) {
            return cfg.optBoolean("quietOn", false)
                    && mins(cfg.optString("quietStart", "01:00")) != mins(cfg.optString("quietEnd", "05:00"));
        }

        static boolean inQuiet(JSONObject cfg, long ms) {
            if (!quietOn(cfg)) return false;
            int s = mins(cfg.optString("quietStart", "01:00"));
            int e = mins(cfg.optString("quietEnd", "05:00"));
            int n = minOfDay(ms);
            return s < e ? (n >= s && n < e) : (n >= s || n < e);
        }

        // Waktu pertama sesudah 'from' pada menit-dalam-hari m
        static long nextAt(long from, int m) {
            Calendar c = Calendar.getInstance();
            c.setTimeInMillis(from);
            c.set(Calendar.HOUR_OF_DAY, m / 60);
            c.set(Calendar.MINUTE, m % 60);
            c.set(Calendar.SECOND, 0);
            c.set(Calendar.MILLISECOND, 0);
            if (c.getTimeInMillis() <= from) c.add(Calendar.DAY_OF_YEAR, 1);
            return c.getTimeInMillis();
        }

        // Pemicu yang jatuh tempo sekarang (label), atau "" kalau tidak ada. Aturannya sama dengan runScheduledTriggers di app.js.
        static String due(JSONObject cfg, long now) {
            if (!cfg.optBoolean("on", false)) return "";
            int s = mins(cfg.optString("quietStart", "01:00"));
            int e = mins(cfg.optString("quietEnd", "05:00"));
            int n = minOfDay(now);
            String today = dayKey(now);
            boolean q = quietOn(cfg);
            if (q && ((n - e + 1440) % 1440) < 20 && !today.equals(cfg.optString("quietEndDay", ""))) return "Selesai jam tenang";
            int until = (s - n + 1440) % 1440;
            if (q && until > 0 && until <= 5 && !today.equals(cfg.optString("quietPreDay", ""))) return "Sebelum jam tenang";
            int autoMin = cfg.optInt("autoMin", 0);
            if (autoMin > 0 && !inQuiet(cfg, now) && now >= cfg.optLong("lastAuto", 0) + autoMin * 60000L - 5000L) return "Otomatis";
            return "";
        }

        static long nextTrigger(JSONObject cfg, long now) {
            if (!cfg.optBoolean("on", false)) return 0;
            if (!due(cfg, now).isEmpty()) return now + 5000L;
            int s = mins(cfg.optString("quietStart", "01:00"));
            int e = mins(cfg.optString("quietEnd", "05:00"));
            long best = Long.MAX_VALUE;
            int autoMin = cfg.optInt("autoMin", 0);
            if (autoMin > 0) {
                long t = Math.max(cfg.optLong("lastAuto", 0) + autoMin * 60000L, now + 5000L);
                if (inQuiet(cfg, t)) t = nextAt(t, e) + 10000L;
                best = Math.min(best, t);
            }
            if (quietOn(cfg)) {
                best = Math.min(best, nextAt(now, e) + 10000L);
                best = Math.min(best, nextAt(now, (s - 5 + 1440) % 1440) + 10000L);
            }
            return best == Long.MAX_VALUE ? 0 : best;
        }

        static PendingIntent pi(Context c, String force) {
            Intent i = new Intent(c, BgReceiver.class).setAction(ACTION_RUN);
            if (force != null) i.putExtra("force", force);
            int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
            return PendingIntent.getBroadcast(c, 7201, i, fl);
        }

        static void armAt(Context c, long t, String force) {
            try {
                AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
                if (am == null) return;
                PendingIntent p = pi(c, force);
                am.cancel(p);
                if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t, p);
                else if (Build.VERSION.SDK_INT >= 23) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t, p);
                else am.setExact(AlarmManager.RTC_WAKEUP, t, p);
            } catch (Exception ignored) {
            }
        }

        static void schedule(Context c) {
            long t = nextTrigger(BgStore.cfg(c), System.currentTimeMillis());
            if (t > 0) {
                armAt(c, t, null);
            } else {
                try {
                    AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
                    if (am != null) am.cancel(pi(c, null));
                } catch (Exception ignored) {
                }
            }
        }
    }

    // Menerima alarm (dan boot / pembaruan aplikasi: hanya memasang ulang alarm, tanpa mengecek)
    public static class BgReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            try {
                Context app = ctx.getApplicationContext();
                String act = intent == null ? null : intent.getAction();
                if (!BgScheduler.ACTION_RUN.equals(act)) {
                    BgScheduler.schedule(app);
                    return;
                }
                String force = intent.getStringExtra("force");
                long now = System.currentTimeMillis();
                String label = force != null ? force : BgScheduler.due(BgStore.cfg(app), now);
                if (label.isEmpty()) {
                    BgScheduler.schedule(app);
                    return;
                }
                if (force == null && sActivityAlive) {
                    // Aplikasi hidup: jadwal dijalankan oleh aplikasi sendiri. Cek lagi nanti.
                    BgScheduler.armAt(app, now + 5 * 60000L, null);
                    return;
                }
                // Jaring pengaman: kalau layanan gagal jalan, alarm ini mencoba lagi 10 menit kemudian
                BgScheduler.armAt(app, now + 10 * 60000L, null);
                Intent si = new Intent(app, BgCheckService.class);
                si.putExtra("label", label);
                if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(si);
                else app.startService(si);
            } catch (Exception ignored) {
            }
        }
    }

    // Layanan latar depan sementara: mengecek akun yang belum Limit satu per satu, menyimpan hasil, lalu berhenti
    public static class BgCheckService extends Service {
        private static boolean sBusy = false;
        private PowerManager.WakeLock wake;

        @Override
        public IBinder onBind(Intent intent) {
            return null;
        }

        @Override
        public int onStartCommand(Intent intent, int flags, int startId) {
            final String label = intent == null || intent.getStringExtra("label") == null ? "Otomatis" : intent.getStringExtra("label");
            try {
                final String ch = "bgcheck";
                if (Build.VERSION.SDK_INT >= 26) {
                    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                    if (nm != null) nm.createNotificationChannel(new NotificationChannel(ch, "Cek akun terjadwal", NotificationManager.IMPORTANCE_LOW));
                }
                Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, ch) : new Notification.Builder(this);
                b.setContentTitle("Account Manager")
                        .setContentText("Mengecek akun di latar belakang...")
                        .setSmallIcon(android.R.drawable.stat_notify_sync)
                        .setOngoing(true);
                if (Build.VERSION.SDK_INT >= 29) startForeground(7102, b.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                else startForeground(7102, b.build());
            } catch (Exception ignored) {
            }
            if (sBusy) return START_NOT_STICKY;
            sBusy = true;
            try {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "claudeaccountmanager:bgcheck");
                    wake.setReferenceCounted(false);
                    wake.acquire(30 * 60 * 1000L);
                }
            } catch (Exception ignored) {
            }
            final Context app = getApplicationContext();
            new Handler(Looper.getMainLooper()).post(new Runnable() {
                @Override
                public void run() {
                    begin(app, label);
                }
            });
            return START_NOT_STICKY;
        }

        private void begin(Context app, String label) {
            JSONObject cfg = BgStore.cfg(app);
            JSONArray all = cfg.optJSONArray("accounts");
            JSONArray todo = new JSONArray();
            if (all != null) {
                for (int i = 0; i < all.length(); i++) {
                    JSONObject a = all.optJSONObject(i);
                    if (a != null && !a.optBoolean("limit", false)) todo.put(a);   // akun Limit tidak dibuka, cukup menunggu jam reset
                }
            }
            next(app, label, todo, 0, new JSONArray());
        }

        private void next(final Context app, final String label, final JSONArray todo, final int i, final JSONArray out) {
            if (i >= todo.length()) {
                finish(app, label, out, "");
                return;
            }
            final JSONObject a = todo.optJSONObject(i);
            GeckoActivity.runCheck(app, a.optString("id"), a.optString("url", "https://claude.ai/new"), 58000, new CheckCallback() {
                @Override
                public void done(JSObject res) {
                    String err = res.optString("error", "");
                    if (!err.isEmpty()) {
                        finish(app, label, out, err);
                        return;
                    }
                    try {
                        JSONObject it = new JSONObject();
                        it.put("id", a.optString("id"));
                        it.put("state", res.optString("state", "unknown"));
                        it.put("text", res.optString("text", ""));
                        it.put("url", res.optString("url", ""));
                        it.put("diag", res.optString("diag", ""));
                        it.put("view", res.optString("view", ""));
                        it.put("at", System.currentTimeMillis());
                        out.put(it);
                    } catch (Exception ignored) {
                    }
                    next(app, label, todo, i + 1, out);
                }
            });
        }

        private void finish(Context app, String label, JSONArray out, String err) {
            try {
                long now = System.currentTimeMillis();
                JSONObject cfg = BgStore.cfg(app);
                JSONArray accts = cfg.optJSONArray("accounts");
                int limit = 0;
                int free = 0;
                int other = 0;
                for (int i = 0; i < out.length(); i++) {
                    JSONObject it = out.optJSONObject(i);
                    if (it == null) continue;
                    String st = it.optString("state", "unknown");
                    boolean isLimit = "limit".equals(st);
                    boolean isFree = "idle".equals(st) || "resume".equals(st) || "reset".equals(st) || "busy".equals(st);
                    if (isLimit) limit++;
                    else if (isFree) free++;
                    else other++;
                    if ((isLimit || isFree) && accts != null) {
                        for (int k = 0; k < accts.length(); k++) {
                            JSONObject a = accts.optJSONObject(k);
                            if (a != null && a.optString("id").equals(it.optString("id"))) a.put("limit", isLimit);
                        }
                    }
                }
                if (!"Uji".equals(label) && err.isEmpty()) {
                    if ("Selesai jam tenang".equals(label)) cfg.put("quietEndDay", BgScheduler.dayKey(now));
                    else if ("Sebelum jam tenang".equals(label)) cfg.put("quietPreDay", BgScheduler.dayKey(now));
                    cfg.put("lastAuto", now);
                }
                BgStore.putCfg(app, cfg);
                if (out.length() > 0 || !err.isEmpty()) {
                    JSONObject run = new JSONObject();
                    run.put("at", now);
                    run.put("label", label);
                    run.put("err", err);
                    run.put("items", out);
                    BgStore.addRun(app, run);
                }
                if (out.length() > 0) notifyDone(app, label, limit, free, other);
            } catch (Exception ignored) {
            }
            try {
                BgScheduler.schedule(app);
            } catch (Exception ignored) {
            }
            try {
                if (wake != null && wake.isHeld()) wake.release();
            } catch (Exception ignored) {
            }
            sBusy = false;
            try {
                stopForeground(true);
            } catch (Exception ignored) {
            }
            stopSelf();
        }

        private void notifyDone(Context app, String label, int limit, int free, int other) {
            try {
                final String ch = "bgresult";
                NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm == null) return;
                if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(new NotificationChannel(ch, "Hasil cek terjadwal", NotificationManager.IMPORTANCE_LOW));
                Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(app, ch) : new Notification.Builder(app);
                StringBuilder sb = new StringBuilder();
                if (limit > 0) sb.append(limit).append(" Limit");
                if (free > 0) sb.append(sb.length() > 0 ? ", " : "").append(free).append(" Free");
                if (other > 0) sb.append(sb.length() > 0 ? ", " : "").append(other).append(" tidak terbaca");
                b.setContentTitle("Cek akun: " + label)
                        .setContentText(sb.toString())
                        .setSmallIcon(android.R.drawable.stat_notify_sync)
                        .setAutoCancel(true);
                Intent li = app.getPackageManager().getLaunchIntentForPackage(app.getPackageName());
                if (li != null) {
                    int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
                    b.setContentIntent(PendingIntent.getActivity(app, 7203, li, fl));
                }
                nm.notify(7103, b.build());
            } catch (Exception ignored) {
            }
        }

        @Override
        public void onDestroy() {
            try {
                if (wake != null && wake.isHeld()) wake.release();
            } catch (Exception ignored) {
            }
            super.onDestroy();
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
        private static volatile long sPasteReqAt = 0;   // waktu tombol Paste email ditekan; content script mengambilnya lewat "pasteCheck"

        // Pengecekan latar belakang: selama sCheckAccountId tidak null, laporan halaman dicatat di sini
        private static volatile String sCheckAccountId = null;
        private static boolean sCheckRunning = false;
        static volatile boolean sCancel = false;   // diset tombol tahan-batal di aplikasi; dibaca loop pengecekan
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

        // Sesi pengecekan dipasang ke GeckoView sungguhan (di bawah layar aplikasi, tidak terlihat) supaya halaman claude.ai
        // mendapat jendela, ukuran layar, dan status "terlihat" persis seperti saat dibuka manual. Tanpa ini halaman bisa tidak
        // merender percakapan dan banner Continue / limit.
        static volatile WeakReference<Activity> sHost = null;
        static volatile boolean sHostVisible = false;
        private static GeckoView sHiddenView = null;
        // Halaman (setelah refresh) sudah selesai dimuat. Pengecekan "idle" baru dianggap pasti setelah ini.
        private static volatile boolean sSettled = false;
        private static volatile long sSettledAt = 0;

        private static GeckoView sOverlayView = null;
        private static WindowManager sOverlayWm = null;
        static volatile String sViewKind = "none";   // tempat sesi tersembunyi dipasang: activity, overlay, none

        // Pasang sesi di GeckoView yang tidak terlihat. Aplikasi terbuka: di bawah layar aplikasi. Aplikasi tertutup atau di belakang:
        // jendela overlay hampir transparan (butuh izin "Tampil di atas aplikasi lain").
        private static void attachHidden(GeckoSession s, Context ctx) {
            sViewKind = "none";
            try {
                Activity act = sHost == null ? null : sHost.get();
                if (act != null && !act.isFinishing() && sHostVisible) {
                    ViewGroup content = act.findViewById(android.R.id.content);
                    if (content != null) {
                        GeckoView v = new GeckoView(act);
                        v.setSession(s);
                        content.addView(v, 0, new FrameLayout.LayoutParams(
                                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                        sHiddenView = v;
                        sViewKind = "activity";
                        return;
                    }
                }
            } catch (Exception e) {
                sHiddenView = null;
            }
            try {
                if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(ctx)) return;
                WindowManager wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
                if (wm == null) return;
                GeckoView v = new GeckoView(ctx);
                v.setSession(s);
                // Ukuran layar penuh supaya halaman dirender normal, tetapi digeser keluar layar: hanya 2 px yang tersisa di tepi kanan.
                // Tidak menutupi aplikasi lain dan tidak menangkap sentuhan.
                android.util.DisplayMetrics dm = ctx.getResources().getDisplayMetrics();
                int w = Math.max(dm.widthPixels, 360);
                int h = Math.max(dm.heightPixels, 640);
                WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                        w, h,
                        Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE,
                        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                        PixelFormat.TRANSLUCENT);
                lp.gravity = Gravity.TOP | Gravity.START;
                lp.x = w - 2;
                lp.alpha = 0.01f;
                lp.y = 0;
                wm.addView(v, lp);
                sOverlayView = v;
                sOverlayWm = wm;
                sViewKind = "overlay";
            } catch (Exception e) {
                sOverlayView = null;
                sOverlayWm = null;
            }
        }

        private static void detachHidden() {
            try {
                GeckoView v = sHiddenView;
                sHiddenView = null;
                if (v != null) {
                    v.releaseSession();
                    ViewGroup p = (ViewGroup) v.getParent();
                    if (p != null) p.removeView(v);
                }
            } catch (Exception ignored) {
            }
            try {
                GeckoView ov = sOverlayView;
                WindowManager wm = sOverlayWm;
                sOverlayView = null;
                sOverlayWm = null;
                if (ov != null) {
                    ov.releaseSession();
                    if (wm != null) wm.removeView(ov);
                }
            } catch (Exception ignored) {
            }
        }

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
            sSettled = false;
            sSettledAt = 0;
            if (!need) {
                sSessionSeq++;
                sReadyAt = SystemClock.uptimeMillis();
                sReady = true;
                s.setProgressDelegate(new GeckoSession.ProgressDelegate() {
                    @Override
                    public void onPageStop(GeckoSession session, boolean success) {
                        sPageStops++;
                        sPageOk = success;
                        sSettled = true;
                        sSettledAt = SystemClock.uptimeMillis();
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
                    if (seq == sSessionSeq && stage[0] == 2) {   // halaman hasil refresh selesai dimuat
                        sSettled = true;
                        sSettledAt = SystemClock.uptimeMillis();
                    }
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
                                } else if ("pasteCheck".equals(type)) {
                                    // Tombol Paste email ditekan: beri email akun sekali saja (tidak untuk sesi pengecekan latar belakang)
                                    JSONObject o = new JSONObject();
                                    boolean fresh = System.currentTimeMillis() - sPasteReqAt < 5000L;
                                    boolean give = fresh && sCheckAccountId == null;
                                    if (give) sPasteReqAt = 0;
                                    o.put("email", give ? sCurrentEmail : "");
                                    o.put("paste", give);
                                    out = new GeckoResult<>();
                                    out.complete(o);
                                } else if ("hello".equals(type)) {
                                    sHello = true;
                                    String hu = msg.optString("url", "");
                                    String ht = msg.optString("title", "");
                                    if (hu.length() > 90) hu = hu.substring(0, 90);
                                    if (ht.length() > 150) ht = ht.substring(0, 150);
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
                    sCancel = false;
                    resetCheck();
                    resetDiag();
                    sBaitMode = "";   // pengecekan biasa
                    sCheckAccountId = accountId;
                    if (sRuntime == null) sRuntime = GeckoRuntime.create(ctx);

                    GeckoSessionSettings settings = new GeckoSessionSettings.Builder()
                            .contextId(accountId)
                            .build();
                    final GeckoSession s = new GeckoSession(settings);
                    // Tanpa refresh paksa di awal: halaman dibaca apa adanya. Kalau 25 detik belum ada hasil, halaman di-refresh sekali (lihat di bawah).
                    setupSession(s, h, false);
                    final boolean[] reloaded = {false};
                    s.open(sRuntime);
                    attachHidden(s, ctx);
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
                            // 25 detik belum ada status apa pun (chat belum termuat): refresh halaman sekali, lalu tunggu lagi sampai batas waktu
                            if (!reloaded[0] && st.isEmpty() && now - start >= 25000) {
                                reloaded[0] = true;
                                resetCheck();
                                sSettled = false;
                                try {
                                    s.reload(GeckoSession.LOAD_FLAGS_NONE);
                                } catch (Exception ignored) {
                                }
                            }
                            // Status positif (limit, Continue, busy, belum login) langsung pasti. Idle baru pasti kalau halaman sudah
                            // selesai dimuat dan tidak ada banner / tombol baru selama 9 detik (banner bisa muncul belakangan).
                            boolean conclusive = !st.isEmpty() && (!"idle".equals(st)
                                    || (sSettled && now - Math.max(at, sSettledAt) >= 9000));
                            if (sCancel) {
                                sCancel = false;
                                JSObject r = new JSObject();
                                r.put("state", "unknown");
                                r.put("error", "cancel");
                                detachHidden();
                                try {
                                    s.close();
                                } catch (Exception ignored) {
                                }
                                sCheckAccountId = null;
                                sCheckRunning = false;
                                cb.done(r);
                                return;
                            }
                            if (conclusive || expired) {
                                JSObject r = new JSObject();
                                synchronized (GeckoActivity.class) {
                                    r.put("state", sCheckState.isEmpty() ? "unknown" : sCheckState);
                                    r.put("text", sCheckText);
                                    r.put("url", sCheckUrl);
                                }
                                r.put("diag", buildDiag());
                                r.put("view", sViewKind);
                                detachHidden();
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
                    sCancel = false;
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
                    attachHidden(s, ctx);
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
                            if (sCancel) {
                                sCancel = false;
                                JSObject r = new JSObject();
                                r.put("state", "fail");
                                r.put("error", "cancel");
                                detachHidden();
                                try {
                                    s.close();
                                } catch (Exception ignored) {
                                }
                                sBaitMode = "";
                                sBaitCmd = "";
                                sCheckAccountId = null;
                                sCheckRunning = false;
                                cb.done(r);
                                return;
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
                                r.put("view", sViewKind);
                                detachHidden();
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
        private View fabPaste;
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

        // Ikon papan klip (Paste): digambar sendiri supaya warnanya sama dengan tombol lain
        private static class PasteIconView extends View {
            private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
            private final RectF r = new RectF();

            PasteIconView(Context c) {
                super(c);
                float d = c.getResources().getDisplayMetrics().density;
                p.setStyle(Paint.Style.STROKE);
                p.setStrokeWidth(1.8f * d);
                p.setStrokeCap(Paint.Cap.ROUND);
                p.setColor(Color.WHITE);
            }

            @Override
            protected void onDraw(Canvas canvas) {
                float w = getWidth(), h = getHeight();
                float u = Math.min(w, h);
                r.set(w / 2f - u * 0.20f, h / 2f - u * 0.22f, w / 2f + u * 0.20f, h / 2f + u * 0.26f);
                canvas.drawRoundRect(r, u * 0.06f, u * 0.06f, p);
                // penjepit di atas
                r.set(w / 2f - u * 0.10f, h / 2f - u * 0.30f, w / 2f + u * 0.10f, h / 2f - u * 0.15f);
                canvas.drawRoundRect(r, u * 0.05f, u * 0.05f, p);
                // dua garis teks
                canvas.drawLine(w / 2f - u * 0.10f, h / 2f, w / 2f + u * 0.10f, h / 2f, p);
                canvas.drawLine(w / 2f - u * 0.10f, h / 2f + u * 0.12f, w / 2f + u * 0.05f, h / 2f + u * 0.12f, p);
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

            fabPaste = new PasteIconView(this);
            fabPaste.setElevation(10 * d);
            GradientDrawable pbg = new GradientDrawable();
            pbg.setShape(GradientDrawable.OVAL);
            pbg.setColor(0xE6071524);
            pbg.setStroke((int) (1 * d), 0x887DD3FC);
            fabPaste.setBackground(pbg);
            fabPaste.setContentDescription("Tempel email akun");
            fabPaste.setVisibility(View.GONE);
            fabPaste.setLayoutParams(new FrameLayout.LayoutParams(btnSize, btnSize));
            fabPaste.setOnClickListener(v -> {
                String em = sCurrentEmail == null ? "" : sCurrentEmail;
                if (em.isEmpty()) {
                    Toast.makeText(this, "Email akun belum diisi. Isi di detail akun.", Toast.LENGTH_SHORT).show();
                } else {
                    try {
                        ClipboardManager cb = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        if (cb != null) cb.setPrimaryClip(ClipData.newPlainText("email", em));   // cadangan kalau kolom tidak terisi otomatis
                    } catch (Exception ignored) {
                    }
                    sPasteReqAt = System.currentTimeMillis();   // content script mengisi kolom yang sedang aktif
                    Toast.makeText(this, "Email ditempel: " + em, Toast.LENGTH_SHORT).show();
                }
                scheduleFabIdle(FAB_IDLE_MS);
                fabH.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        closeFabMenu();
                    }
                }, 250);
            });

            fab = new BubbleView(this);
            fab.setElevation(12 * d);
            fab.setContentDescription("Menu melayang: beranda, muat ulang, tempel email");
            fab.setLayoutParams(new FrameLayout.LayoutParams(fabSize, fabSize));

            root.addView(fabHome);
            root.addView(fabRefresh);
            root.addView(fabPaste);
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

        // Tiga tombol keluar melingkari tombol utama, berurutan:
        //   1. Home    -> ke atas
        //   2. Refresh -> ke samping (ke kanan kalau tombol utama di kiri, ke kiri kalau di kanan)
        //   3. Paste   -> ke bawah
        private void openFabMenu() {
            if (fabOpen || fab == null) return;
            View parent = (View) fab.getParent();
            if (parent == null) return;
            float d = getResources().getDisplayMetrics().density;
            float gap = 10 * d;
            float bs = fabHome.getLayoutParams().width;
            float dist = fab.getWidth() / 2f + gap + bs / 2f;   // jarak pusat tombol utama ke pusat tombol kecil
            boolean toRight = fab.getX() + fab.getWidth() / 2f < parent.getWidth() / 2f;
            float cx = fab.getX() + fab.getWidth() / 2f - bs / 2f;   // posisi kiri-atas tombol kecil saat di pusat
            float cy = fab.getY() + fab.getHeight() / 2f - bs / 2f;
            float maxX = parent.getWidth() - bs;
            float maxY = parent.getHeight() - bs;
            float upY = Math.max(0, Math.min(maxY, cy - dist));
            float downY = Math.max(0, Math.min(maxY, cy + dist));
            float sideX = Math.max(0, Math.min(maxX, toRight ? cx + dist : cx - dist));
            fabOpen = true;
            showFabAction(fabHome, cx, cy, cx, upY, 0);
            showFabAction(fabRefresh, cx, cy, sideX, cy, 70);
            showFabAction(fabPaste, cx, cy, cx, downY, 140);
        }

        private void showFabAction(View b, float fromX, float fromY, float toX, float toY, long delay) {
            b.animate().cancel();
            b.setX(fromX);
            b.setY(fromY);
            b.setAlpha(0f);
            b.setScaleX(0.4f);
            b.setScaleY(0.4f);
            b.setVisibility(View.VISIBLE);
            b.animate().x(toX).y(toY).alpha(1f).scaleX(1f).scaleY(1f).setStartDelay(delay).setDuration(220)
                    .setInterpolator(new DecelerateInterpolator()).start();
        }

        private void closeFabMenu() {
            if (!fabOpen || fab == null) return;
            fabOpen = false;
            float bs = fabHome.getLayoutParams().width;
            float cx = fab.getX() + fab.getWidth() / 2f - bs / 2f;
            float cy = fab.getY() + fab.getHeight() / 2f - bs / 2f;
            hideFabAction(fabPaste, cx, cy, 0);
            hideFabAction(fabRefresh, cx, cy, 30);
            hideFabAction(fabHome, cx, cy, 60);
        }

        private void hideFabAction(final View b, float toX, float toY, long delay) {
            b.animate().cancel();
            b.animate().x(toX).y(toY).alpha(0f).scaleX(0.4f).scaleY(0.4f).setStartDelay(delay).setDuration(160)
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
