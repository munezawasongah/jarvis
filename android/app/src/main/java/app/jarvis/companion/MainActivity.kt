package app.jarvis.companion

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** One screen: server address, access token, connect/stop, and a checklist of what still needs granting. */
class MainActivity : Activity() {

    private lateinit var server: EditText
    private lateinit var token: EditText
    private lateinit var status: TextView
    private lateinit var checks: TextView

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { onClick() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), dp(28))
        }
        col.addView(TextView(this).apply { text = "JARVIS COMPANION"; textSize = 20f; letterSpacing = 0.2f })
        col.addView(TextView(this).apply {
            text = "Lets your Jarvis server send texts, make calls, open apps and operate this phone when you ask it to."
            setPadding(0, dp(6), 0, dp(16))
        })

        server = EditText(this).apply {
            hint = "Server address, e.g. https://jarvis.example.com or 192.168.1.20:3000"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(Prefs.server(this@MainActivity))
        }
        token = EditText(this).apply {
            hint = "Access token"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setText(Prefs.token(this@MainActivity))
        }
        col.addView(server)
        col.addView(token)

        status = TextView(this).apply { textSize = 16f; setPadding(0, dp(14), 0, dp(6)); text = BridgeService.status }
        col.addView(status)

        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(button("Save and connect") {
            Prefs.save(this, server.text.toString(), token.text.toString())
            Prefs.setEnabled(this, true)
            BridgeService.start(this)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(button("Stop") {
            Prefs.setEnabled(this, false)
            BridgeService.stop(this)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        col.addView(row)

        col.addView(TextView(this).apply { text = "Setup checklist"; textSize = 17f; setPadding(0, dp(22), 0, dp(6)) })
        checks = TextView(this).apply { setLineSpacing(0f, 1.25f) }
        col.addView(checks)

        col.addView(button("1. Allow SMS, calls, contacts, notifications") { requestRuntimePermissions() })
        col.addView(button("2. Turn on the accessibility service") {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        })
        col.addView(button("3. Allow display over other apps") {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        })
        col.addView(button("4. Stop battery limits (keeps it connected)") {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        })
        col.addView(TextView(this).apply {
            text = "Android 13+ blocks sideloaded apps from using accessibility until you open App info for this app, tap the ⋮ menu and choose “Allow restricted settings”."
            textSize = 13f
            setPadding(0, dp(14), 0, 0)
            gravity = Gravity.START
        })

        setContentView(ScrollView(this).apply { addView(col) })
    }

    override fun onResume() {
        super.onResume()
        BridgeService.listener = { s -> runOnUiThread { status.text = s } }
        status.text = BridgeService.status
        refreshChecks()
    }

    override fun onPause() {
        BridgeService.listener = null
        super.onPause()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refreshChecks()
    }

    private fun granted(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun requestRuntimePermissions() {
        val wanted = mutableListOf(Manifest.permission.SEND_SMS, Manifest.permission.CALL_PHONE, Manifest.permission.READ_CONTACTS)
        if (Build.VERSION.SDK_INT >= 33) wanted.add(Manifest.permission.POST_NOTIFICATIONS)
        requestPermissions(wanted.toTypedArray(), 1)
    }

    private fun refreshChecks() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        fun mark(ok: Boolean, label: String) = (if (ok) "✔  " else "✘  ") + label
        checks.text = listOf(
            mark(granted(Manifest.permission.SEND_SMS), "Send SMS"),
            mark(granted(Manifest.permission.CALL_PHONE), "Place calls"),
            mark(granted(Manifest.permission.READ_CONTACTS), "Read contacts"),
            mark(JarvisAccessibilityService.instance != null, "Accessibility service (screen, tap, type, WhatsApp)"),
            mark(Settings.canDrawOverlays(this), "Display over other apps"),
            mark(pm.isIgnoringBatteryOptimizations(packageName), "Not battery-limited"),
        ).joinToString("\n")
    }
}
