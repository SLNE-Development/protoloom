plugins {
    `kotlin-dsl`
    `maven-publish`
    kotlin("plugin.serialization") version embeddedKotlinVersion
}

group = "dev.protoloom"
version = "0.1.0"

repositories {
    mavenCentral()
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")

    testImplementation(platform("org.junit:junit-bom:6.1.3"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation(kotlin("test-junit5"))
    testImplementation("org.apache.commons:commons-compress:1.28.0")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

gradlePlugin {
    plugins {
        create("protoloom") {
            id = "dev.protoloom"
            implementationClass = "dev.protoloom.gradle.ProtoloomPlugin"
            displayName = "Protoloom"
            description = "Publishes .proto bundles to a Protoloom registry and fetches them with their dependencies."
        }
    }
}

publishing {
    repositories {
        val publishUrl = providers.environmentVariable("PUBLISH_URL")
        if (publishUrl.isPresent) {
            maven {
                name = "protoloom"
                url = uri(publishUrl.get())
                credentials {
                    username = providers.environmentVariable("PUBLISH_USERNAME").orNull
                    password = providers.environmentVariable("PUBLISH_PASSWORD").orNull
                }
            }
        }
    }
}

tasks.test {
    useJUnitPlatform()
    // TestKit builds start their own daemons; keep the test JVM from inheriting a registry URL or token.
    environment.remove("PROTOLOOM_URL")
    environment.remove("PROTOLOOM_TOKEN")
}
