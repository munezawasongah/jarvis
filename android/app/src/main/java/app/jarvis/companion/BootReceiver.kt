package app.jarvis.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Reconnects to the Jarvis server after the phone restarts (only if you left it switched on). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (Prefs.enabled(context) && Prefs.server(context).isNotBlank() && Prefs.token(context).isNotBlank()) {
            BridgeService.start(context)
        }
    }
}
