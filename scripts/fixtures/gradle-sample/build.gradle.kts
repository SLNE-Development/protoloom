plugins {
    id("dev.protoloom")
}

group = "dev.smoke"
version = "1.0.0"

// PROTOLOOM_URL and PROTOLOOM_TOKEN come from the environment.
protoloom {
    repositories("releases")
    publishing {
        repository.set("releases")
        group.set("dev.smoke")
        name.set("sample")
    }
}
