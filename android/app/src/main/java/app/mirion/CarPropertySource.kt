package app.mirion

import android.car.Car
import android.car.VehiclePropertyIds
import android.car.hardware.property.CarPropertyManager
import android.content.Context

class CarPropertySource(context: Context) {
    private val car: Car? = runCatching { Car.createCar(context) }.getOrNull()
    private val properties: CarPropertyManager? =
        runCatching { car?.getCarManager(Car.PROPERTY_SERVICE) as? CarPropertyManager }.getOrNull()

    fun snapshot(): Map<String, Any> {
        val out = HashMap<String, Any>()
        readFloat(VehiclePropertyIds.PERF_VEHICLE_SPEED)?.let { out["speedKmh"] = it * 3.6f }
        readFloat(VehiclePropertyIds.ENV_OUTSIDE_TEMPERATURE)?.let { out["outsideTemp"] = it }
        readInt(VehiclePropertyIds.GEAR_SELECTION)?.let { out["gear"] = gearName(it) }
        return out
    }

    fun stop() {
        runCatching { car?.disconnect() }
    }

    private fun readFloat(id: Int): Float? =
        runCatching { properties?.getFloatProperty(id, 0) }.getOrNull()

    private fun readInt(id: Int): Int? =
        runCatching { properties?.getIntProperty(id, 0) }.getOrNull()

    private fun gearName(gear: Int): String = when (gear) {
        0x0004 -> "P"
        0x0002 -> "R"
        0x0001 -> "N"
        else -> "D"
    }
}
