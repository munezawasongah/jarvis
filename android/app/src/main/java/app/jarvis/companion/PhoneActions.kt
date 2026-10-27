package app.jarvis.companion

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.provider.AlarmClock
import android.provider.ContactsContract
import android.telephony.SmsManager
import org.json.JSONArray
import org.json.JSONObject

/** Executes the commands the Jarvis server sends. Runs on a background thread. */
class PhoneActions(private val ctx: Context) {

    fun run(action: String, p: JSONObject): Any = when (action) {
        "device_info" -> deviceInfo()
        "open_app" -> openApp(p.getString("name"))
        "open_url" -> openUrl(p.getString("url"))
        "call" -> call(p.getString("number"))
        "find_contact" -> findContact(p.getString("name"))
        "sms_send" -> sendSms(p.getString("to"), p.getString("text"))
        "whatsapp_send" -> sendWhatsApp(p.getString("to"), p.getString("text"))
        "read_screen" -> a11y().readScreen()
        "tap" -> {
            val t = p.getString("text")
            if (a11y().tapText(t)) "Tapped \"$t\"." else throw IllegalStateException("Could not find \"$t\" on the screen.")
        }
        "type" -> if (a11y().typeText(p.getString("text"))) "Typed." else throw IllegalStateException("No input field is focused. Tap a text field first.")
        "scroll" -> if (a11y().scroll(p.getString("direction") == "down")) "Scrolled." else throw IllegalStateException("The scroll gesture did not complete.")
        "global" -> if (a11y().global(p.getString("action"))) "Done." else throw IllegalStateException("That button press is not supported.")
        "set_alarm" -> setAlarm(p.getInt("hour"), p.getInt("minute"), p.optString("label", "Jarvis"))
        "notify" -> notifyUser(p.optString("title", "Jarvis"), p.optString("text", ""))
        else -> throw IllegalArgumentException("Unknown action: $action")
    }

    // ---------- helpers ----------

    private fun a11y(): JarvisAccessibilityService =
        JarvisAccessibilityService.instance
            ?: throw IllegalStateException("The Jarvis accessibility service is off. Turn it on in Settings > Accessibility on the phone.")

    private fun has(permission: String) = ctx.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    /** An app with the accessibility service running may start activities from the background. */
    private fun launcher(): Context = JarvisAccessibilityService.instance ?: ctx

    private fun start(intent: Intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        launcher().startActivity(intent)
    }

    // ---------- actions ----------

    private fun deviceInfo(): JSONObject {
        val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return JSONObject()
            .put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("android", Build.VERSION.RELEASE)
            .put("battery", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
            .put("accessibility", JarvisAccessibilityService.instance != null)
            .put("sms", has(Manifest.permission.SEND_SMS))
            .put("calls", has(Manifest.permission.CALL_PHONE))
            .put("contacts", has(Manifest.permission.READ_CONTACTS))
    }

    private fun openApp(name: String): String {
        val pm = ctx.packageManager
        val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = pm.queryIntentActivities(launcherIntent, 0)
        val q = name.trim().lowercase()
        val match = apps.firstOrNull { it.loadLabel(pm).toString().lowercase() == q }
            ?: apps.firstOrNull { it.loadLabel(pm).toString().lowercase().contains(q) }
            ?: throw IllegalStateException("No app called \"$name\" is installed.")
        val intent = pm.getLaunchIntentForPackage(match.activityInfo.packageName)
            ?: throw IllegalStateException("\"$name\" cannot be launched.")
        start(intent)
        return "Opened ${match.loadLabel(pm)}."
    }

    private fun openUrl(url: String): String {
        val uri = Uri.parse(url)
        val scheme = uri.scheme?.lowercase()
        if (scheme !in listOf("http", "https", "tel", "mailto", "geo", "sms", "smsto")) {
            throw IllegalArgumentException("Links of type \"$scheme\" are not allowed.")
        }
        start(Intent(Intent.ACTION_VIEW, uri))
        return "Opened $url."
    }

    private fun call(number: String): String {
        if (!has(Manifest.permission.CALL_PHONE)) throw SecurityException("The phone has not allowed Jarvis to place calls. Grant the Phone permission in the companion app.")
        start(Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(number))))
        return "Calling $number."
    }

    private fun findContact(name: String): JSONArray {
        if (!has(Manifest.permission.READ_CONTACTS)) throw SecurityException("The phone has not allowed Jarvis to read contacts. Grant the Contacts permission in the companion app.")
        val out = JSONArray()
        val seen = HashSet<String>()
        val cols = arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER)
        ctx.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI, cols,
            "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ?", arrayOf("%$name%"),
            "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC",
        )?.use { c ->
            while (c.moveToNext() && out.length() < 8) {
                val n = c.getString(0) ?: continue
                val num = c.getString(1) ?: continue
                val key = num.filter { it.isDigit() }.takeLast(9)
                if (seen.add(key)) out.put(JSONObject().put("name", n).put("number", num))
            }
        }
        return out
    }

    private fun sendSms(to: String, text: String): String {
        if (!has(Manifest.permission.SEND_SMS)) throw SecurityException("The phone has not allowed Jarvis to send SMS. Grant the SMS permission in the companion app.")
        @Suppress("DEPRECATION")
        val sms = if (Build.VERSION.SDK_INT >= 31) ctx.getSystemService(SmsManager::class.java) else SmsManager.getDefault()
        val parts = sms.divideMessage(text)
        if (parts.size > 1) sms.sendMultipartTextMessage(to, null, parts, null, null)
        else sms.sendTextMessage(to, null, text, null, null)
        return "SMS handed to the network for $to."
    }

    private fun sendWhatsApp(to: String, text: String): String {
        val svc = a11y()
        val digits = to.filter { it.isDigit() }
        if (to.trim().startsWith("0") || digits.length < 8) {
            throw IllegalArgumentException("WhatsApp needs the number in international format, like +255712345678. Got \"$to\".")
        }
        val uri = Uri.parse("https://wa.me/$digits?text=" + Uri.encode(text))
        val pm = ctx.packageManager
        val pkg = listOf("com.whatsapp", "com.whatsapp.w4b").firstOrNull {
            try { pm.getPackageInfo(it, 0); true } catch (e: PackageManager.NameNotFoundException) { false }
        } ?: throw IllegalStateException("WhatsApp is not installed on the phone.")
        start(Intent(Intent.ACTION_VIEW, uri).setPackage(pkg))

        // Wait for the chat to open with the text pre-filled, then press Send.
        val deadline = System.currentTimeMillis() + 15000
        Thread.sleep(1500)
        while (System.currentTimeMillis() < deadline) {
            val root = svc.rootInActiveWindow
            if (root != null && root.packageName?.toString()?.startsWith("com.whatsapp") == true) {
                val send = svc.findNode(root, "send")
                if (send != null && svc.click(send)) return "WhatsApp message sent to $to."
            }
            Thread.sleep(500)
        }
        throw IllegalStateException("Opened the WhatsApp chat but could not find the Send button (it is matched by its English label \"Send\"). The message is drafted in the chat; it was NOT sent.")
    }

    private fun setAlarm(hour: Int, minute: Int, label: String): String {
        val i = Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, hour)
            .putExtra(AlarmClock.EXTRA_MINUTES, minute)
            .putExtra(AlarmClock.EXTRA_MESSAGE, label)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        start(i)
        return "Alarm set for %02d:%02d.".format(hour, minute)
    }

    private fun notifyUser(title: String, text: String): String {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel("jarvis_events", "Jarvis", NotificationManager.IMPORTANCE_HIGH))
        val n = android.app.Notification.Builder(ctx, "jarvis_events")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(android.app.Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .build()
        nm.notify((System.currentTimeMillis() % 100000).toInt() + 10, n)
        return "Notified."
    }
}
