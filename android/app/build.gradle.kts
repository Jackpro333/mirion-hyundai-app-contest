plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.mirion"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.mirion"
        minSdk = 28
        targetSdk = 34
        versionCode = 1
        versionName = "0.2.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    useLibrary("android.car")
}

dependencies {
    implementation("ai.pleos.playground:Vehicle:2.3.2")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
}
