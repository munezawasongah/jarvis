package app.jarvis.companion

import android.content.Context

/** Server address and access token, stored privately on this phone only. */
object Prefs {
    private fun sp(c: Context) = c.getSharedPreferences("jarvis", Context.MODE_PRIVATE)

    fun server(c: Context): String = sp(c).getString("server", "") ?: ""
    fun token(c: Context): String = sp(c).getString("token", "") ?: ""
    fun enabled(c: Context): Boolean = sp(c).getBoolean("enabled", false)

    fun save(c: Context, server: String, token: String) {
        sp(c).edit().putString("server", server.trim()).putString("token", token.trim()).apply()
    }

    fun setEnabled(c: Context, on: Boolean) {
        sp(c).edit().putBoolean("enabled", on).apply()
    }
}
