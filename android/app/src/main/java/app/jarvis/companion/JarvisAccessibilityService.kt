package app.jarvis.companion

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Lets Jarvis read the screen, tap, type and scroll. Android only allows this once you switch the
 * service on yourself in Settings > Accessibility. It does nothing on its own: it only acts when
 * your Jarvis server sends a command.
 */
class JarvisAccessibilityService : AccessibilityService() {

    companion object {
        @Volatile
        var instance: JarvisAccessibilityService? = null
    }

    override fun onServiceConnected() {
        instance = this
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        if (instance === this) instance = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) { /* commands only; nothing to observe */ }
    override fun onInterrupt() {}

    // ---------- reading ----------

    fun readScreen(): String {
        val root = rootInActiveWindow ?: return "The screen content is not available (secure screen or the screen is off)."
        val lines = ArrayList<String>()
        lines.add("App: ${root.packageName}")
        fun walk(n: AccessibilityNodeInfo?, depth: Int) {
            if (n == null || lines.size > 220 || depth > 40) return
            val text = n.text?.toString()?.trim().orEmpty()
            val desc = n.contentDescription?.toString()?.trim().orEmpty()
            val label = listOf(text, desc).filter { it.isNotEmpty() }.distinct().joinToString(" | ")
            if (n.isVisibleToUser && (label.isNotEmpty() || n.isEditable)) {
                val kind = when {
                    n.isEditable -> "[input]"
                    n.isClickable -> "[button]"
                    else -> "[text]"
                }
                lines.add("$kind ${label.take(200)}")
            }
            for (i in 0 until n.childCount) walk(n.getChild(i), depth + 1)
        }
        walk(root, 0)
        return lines.joinToString("\n")
    }

    // ---------- finding and clicking ----------

    fun findNode(root: AccessibilityNodeInfo, query: String): AccessibilityNodeInfo? {
        val q = query.trim().lowercase()
        var exact: AccessibilityNodeInfo? = null
        var partial: AccessibilityNodeInfo? = null
        fun walk(n: AccessibilityNodeInfo?, depth: Int) {
            if (n == null || exact != null || depth > 40) return
            val labels = listOfNotNull(n.text?.toString(), n.contentDescription?.toString()).map { it.trim().lowercase() }
            if (labels.any { it == q }) { exact = n; return }
            if (partial == null && labels.any { it.contains(q) }) partial = n
            for (i in 0 until n.childCount) walk(n.getChild(i), depth + 1)
        }
        walk(root, 0)
        return exact ?: partial
    }

    fun click(node: AccessibilityNodeInfo): Boolean {
        var n: AccessibilityNodeInfo? = node
        var hops = 0
        while (n != null && hops < 8) {
            if (n.isClickable && n.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
            n = n.parent
            hops++
        }
        return false
    }

    fun tapText(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val node = findNode(root, text) ?: return false
        return click(node)
    }

    // ---------- typing, scrolling, buttons ----------

    fun typeText(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val node = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
        val existing = if (node.isShowingHintText) "" else node.text?.toString().orEmpty()
        val args = Bundle()
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, existing + text)
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    /** direction "down" moves the content up (reveals what is below), like a finger swiping up. */
    fun scroll(down: Boolean): Boolean {
        val dm = resources.displayMetrics
        val x = dm.widthPixels / 2f
        val h = dm.heightPixels.toFloat()
        val from = if (down) h * 0.7f else h * 0.3f
        val to = if (down) h * 0.3f else h * 0.7f
        val path = Path().apply { moveTo(x, from); lineTo(x, to) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 300))
            .build()
        val latch = CountDownLatch(1)
        var ok = false
        val dispatched = dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(g: GestureDescription?) { ok = true; latch.countDown() }
            override fun onCancelled(g: GestureDescription?) { latch.countDown() }
        }, null)
        if (!dispatched) return false
        latch.await(3, TimeUnit.SECONDS)
        return ok
    }

    fun global(action: String): Boolean {
        val code = when (action) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS
            "lock_screen" -> GLOBAL_ACTION_LOCK_SCREEN
            else -> return false
        }
        return performGlobalAction(code)
    }
}
