package app.mirion

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    private lateinit var pleos: PleosVehicleSource
    private lateinit var car: CarPropertySource
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pleos = PleosVehicleSource(applicationContext)
        car = CarPropertySource(applicationContext)
        pleos.start()
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.allowFileAccess = true
        web.addJavascriptInterface(VehicleBridge(pleos, car), "MirionBridge")
        setContentView(web)
        web.loadUrl("file:///android_asset/car.html")
    }

    override fun onDestroy() {
        web.removeJavascriptInterface("MirionBridge")
        web.destroy()
        car.stop()
        pleos.stop()
        super.onDestroy()
    }
}
