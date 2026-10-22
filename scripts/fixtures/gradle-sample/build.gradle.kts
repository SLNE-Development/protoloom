plugins {
    id("dev.slne.weaver")
}

group = "dev.smoke"
version = "1.0.0"

// WEAVER_URL and WEAVER_TOKEN come from the environment.
weaver {
    repositories("releases")
    publishing {
        repository.set("releases")
        group.set("dev.smoke")
        name.set("sample")
    }
}
