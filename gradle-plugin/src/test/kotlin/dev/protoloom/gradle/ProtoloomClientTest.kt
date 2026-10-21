package dev.protoloom.gradle

import org.junit.jupiter.api.Test
import java.net.URI
import kotlin.test.assertEquals

class ProtoloomClientTest {
    private val client = ProtoloomClient("https://registry.example.com", "token")

    @Test
    fun `an explicit 443 is the same origin as the default https port`() {
        val archive = "https://registry.example.com:443/api/v1/repos/releases/artifacts/g/n/1.0.0/archive"

        assertEquals(URI.create(archive), client.archiveUri(archive))
    }

    @Test
    fun `another port is a different origin and is rebased onto the configured url`() {
        val archive = "https://registry.example.com:8443/api/v1/repos/releases/artifacts/g/n/1.0.0/archive"

        assertEquals(
            URI.create("https://registry.example.com/api/v1/repos/releases/artifacts/g/n/1.0.0/archive"),
            client.archiveUri(archive),
        )
    }
}
