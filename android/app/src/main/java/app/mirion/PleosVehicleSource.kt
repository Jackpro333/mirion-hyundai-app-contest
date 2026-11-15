package app.mirion

import android.content.Context
import ai.pleos.playground.vehicle.Vehicle
import ai.pleos.playground.vehicle.api.model.area.SeatArea
import ai.pleos.playground.vehicle.constant.area.SeatValue
import ai.pleos.playground.vehicle.constant.unit.TemperatureUnit
import java.util.concurrent.ConcurrentHashMap

class PleosVehicleSource(context: Context) {
    private val vehicle = Vehicle(context)
    private val driver = SeatArea(SeatValue.ROW_1_LEFT)
    private val seats = mapOf(
        "seatFrontLeft" to SeatArea(SeatValue.ROW_1_LEFT),
        "seatFrontRight" to SeatArea(SeatValue.ROW_1_RIGHT),
        "seatRearLeft" to SeatArea(SeatValue.ROW_2_LEFT),
        "seatRearCenter" to SeatArea(SeatValue.ROW_2_CENTER),
        "seatRearRight" to SeatArea(SeatValue.ROW_2_RIGHT)
    )
    private val values = ConcurrentHashMap<String, Any>()
    private val failures = ConcurrentHashMap<String, String>()

    fun start() {
        vehicle.initialize()
    }

    fun stop() {
        vehicle.release()
    }

    fun refresh() {
        val hvac = vehicle.getHVAC()
        hvac.getHvacTemperatureCurrent(
            area = driver,
            onComplete = { value: Float? -> put("cabinTemp", value) },
            onFailed = { e: Exception -> fail("cabinTemp", e) }
        )
        hvac.getHvacTemperature(
            area = driver,
            unit = TemperatureUnit.CELSIUS,
            onComplete = { value: Float? -> put("setTemp", value) },
            onFailed = { e: Exception -> fail("setTemp", e) }
        )
        hvac.getHvacRecirculationState(
            area = driver,
            onComplete = { value: Boolean? -> put("recirculation", value) },
            onFailed = { e: Exception -> fail("recirculation", e) }
        )
        hvac.getHvacFanSpeed(
            area = driver,
            onComplete = { value: Int? -> put("fanSpeed", value) },
            onFailed = { e: Exception -> fail("fanSpeed", e) }
        )
        val battery = vehicle.getEvBattery()
        battery.getEvBatteryStateOfCharge(
            onComplete = { value: Int? -> put("batterySoc", value) },
            onFailed = { e: Exception -> fail("batterySoc", e) }
        )
        battery.getEvChargeSwitchState(
            onComplete = { value: Boolean? -> put("charging", value) },
            onFailed = { e: Exception -> fail("charging", e) }
        )
        val seat = vehicle.getSeat()
        for ((key, area) in seats) {
            seat.getCurrentSeatOccupancy(
                area = area,
                onComplete = { value: Boolean? -> put(key, value) },
                onFailed = { e: Exception -> fail(key, e) }
            )
        }
        seat.getHvacSeatTemperature(
            area = driver,
            onComplete = { value: Int? -> put("seatLevel", value) },
            onFailed = { e: Exception -> fail("seatLevel", e) }
        )
    }

    fun setRecirculation(on: Boolean, onFailed: (Exception) -> Unit) {
        vehicle.getHVAC().setHvacRecirculation(
            area = driver,
            value = on,
            onFailed = onFailed
        )
    }

    fun setTemperature(celsius: Float, onFailed: (Exception) -> Unit) {
        vehicle.getHVAC().setHvacTemperature(
            area = driver,
            value = celsius,
            unit = TemperatureUnit.CELSIUS,
            onFailed = onFailed
        )
    }

    fun setSeatHeat(level: Int, onFailed: (Exception) -> Unit) {
        vehicle.getSeat().setHvacSeatTemperature(
            area = driver,
            value = level,
            onFailed = onFailed
        )
    }

    fun snapshot(): Map<String, Any> {
        val out = HashMap<String, Any>(values)
        val known = seats.keys.filter { values[it] is Boolean }
        if (known.isNotEmpty()) {
            out["occupants"] = maxOf(1, known.count { values[it] == true })
        }
        return out
    }

    fun errors(): Map<String, String> = HashMap(failures)

    private fun put(key: String, value: Any?) {
        if (value == null) {
            values.remove(key)
        } else {
            values[key] = value
            failures.remove(key)
        }
    }

    private fun fail(key: String, e: Exception) {
        values.remove(key)
        failures[key] = e.message ?: e.javaClass.simpleName
    }
}
