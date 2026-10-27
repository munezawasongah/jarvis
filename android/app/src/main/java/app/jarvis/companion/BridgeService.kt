package app.jarvis.companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Keeps a WebSocket open to your Jarvis server and runs the commands it sends. */
class BridgeService : Service() {

    companion object {
        @Volatile var status: String = "Not connected"
        @Volatile var listener: ((String) -> Unit)? = null

        fun start(ctx: Context) {
            val i = Intent(ctx, BridgeService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, BridgeService::class.java))
        }

        private fun updateStatus(s: String) {
            status = s
            listener?.invoke(s)
        }
    }

    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val handler = Handler(Looper.getMainLooper())
    private val pool = Executors.newCachedThreadPool()
    private lateinit var actions: PhoneActions
    private var socket: WebSocket? = null
    private var retry = 0
    private var stopped = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        actions = PhoneActions(applicationContext)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        goForeground()
        stopped = false
        if (socket == null) connect()
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
        handler.removeCallbacksAndMessages(null)
        socket?.close(1000, "service stopped")
        socket = null
        pool.shutdownNow()
        updateStatus("Stopped")
        super.onDestroy()
    }

    private fun goForeground() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel("jarvis_bridge", "Jarvis connection", NotificationManager.IMPORTANCE_LOW))
        val open = android.app.PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = Notification.Builder(this, "jarvis_bridge")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Jarvis is connected")
            .setContentText("Ready for your commands")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(1, n)
    }

    private fun wsUrl(): String? {
        var s = Prefs.server(this).trim().trimEnd('/')
        val token = Prefs.token(this)
        if (s.isEmpty() || token.isEmpty()) return null
        if (!Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(s)) s = "http://$s"
        val base = s.replaceFirst(Regex("^http", RegexOption.IGNORE_CASE), "ws") // http -> ws, https -> wss
        return "$base/phone?token=" + URLEncoder.encode(token, "UTF-8")
    }

    private fun connect() {
        if (stopped) return
        val url = wsUrl()
        if (url == null) {
            updateStatus("Enter the server address and token first")
            stopSelf()
            return
        }
        updateStatus(if (retry == 0) "Connecting…" else "Reconnecting (attempt ${retry + 1})…")
        val request = try { Request.Builder().url(url).build() } catch (e: IllegalArgumentException) {
            updateStatus("The server address is not valid")
            stopSelf()
            return
        }
        val me = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                retry = 0
                updateStatus("Connected")
                val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
                webSocket.send(
                    JSONObject().put("type", "hello")
                        .put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
                        .put("battery", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
                        .put("version", "0.1.0")
                        .toString(),
                )
            }

            override fun onMessage(webSocket: WebSocket, text: String) = handle(webSocket, text)

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = lost(webSocket, "Disconnected")

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val why = if (response?.code == 401) "Wrong access token" else (t.message ?: "connection failed")
                lost(webSocket, why)
            }
        })
        socket = me
    }

    private fun lost(ws: WebSocket, why: String) {
        if (socket !== ws) return
        socket = null
        if (stopped) return
        retry++
        val delay = minOf(30_000L, 1000L shl minOf(retry, 5))
        updateStatus("$why. Retrying in ${delay / 1000}s…")
        handler.postDelayed({ if (socket == null) connect() }, delay)
    }

    private fun handle(ws: WebSocket, text: String) {
        val m = try { JSONObject(text) } catch (e: Exception) { return }
        if (m.optString("type") != "command") return
        val id = m.optString("id")
        val action = m.optString("action")
        val params = m.optJSONObject("params") ?: JSONObject()
        pool.execute {
            val reply = JSONObject().put("type", "result").put("id", id)
            try {
                reply.put("ok", true).put("result", actions.run(action, params))
            } catch (e: Throwable) {
                reply.put("ok", false).put("error", e.message ?: e.javaClass.simpleName)
            }
            ws.send(reply.toString())
        }
    }
}
