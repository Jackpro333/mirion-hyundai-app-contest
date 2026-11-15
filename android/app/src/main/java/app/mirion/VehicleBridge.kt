package app.mirion

import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.util.Calendar

class VehicleBridge(
    private val pleos: PleosVehicleSource,
    private val car: CarPropertySource
) {
    @Volatile
    private var lastError: String? = null

    @JavascriptInterface
    fun snapshot(): String {
        pleos.refresh()
        val json = JSONObject()
        for ((key, value) in car.snapshot()) json.put(key, value)
        for ((key, value) in pleos.snapshot()) json.put(key, value)
        val now = Calendar.getInstance()
        json.put("hour", now.get(Calendar.HOUR_OF_DAY) + now.get(Calendar.MINUTE) / 60.0)
        json.put("timeSeconds", System.currentTimeMillis() / 1000.0)
        val errors = JSONObject()
        for ((key, value) in pleos.errors()) errors.put(key, value)
        lastError?.let { errors.put("control", it) }
        json.put("errors", errors)
        return json.toString()
    }

    @JavascriptInterface
    fun apply(commandJson: String): Boolean {
        val command = runCatching { JSONObject(commandJson) }.getOrNull() ?: return false
        return when (command.optString("type")) {
            "recirculation" -> {
                pleos.setRecirculation(command.optBoolean("on")) { e -> lastError = e.message }
                true
            }
            "temperature" -> {
                val value = command.optDouble("celsius", Double.NaN)
                if (value.isNaN() || value < 17.0 || value > 30.0) return false
                pleos.setTemperature(value.toFloat()) { e -> lastError = e.message }
                true
            }
            "seatHeat" -> {
                val level = command.optInt("level", -1)
                if (level < 0 || level > 3) return false
                pleos.setSeatHeat(level) { e -> lastError = e.message }
                true
            }
            else -> false
        }
    }
}
