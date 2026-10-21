package dev.protoloom.gradle

import com.sun.net.httpserver.HttpServer
import org.gradle.api.GradleException
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.net.InetSocketAddress
import java.net.URI
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

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

    @TempDir
    lateinit var tmp: File

    /** Publishes against a server that answers every request with [status] and [body]. */
    private fun publishAgainst(status: Int, body: String): GradleException {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            exchange.requestBody.readBytes()
            val bytes = body.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            val archive = File(tmp, "a.tar.gz").apply { writeBytes(byteArrayOf(1, 2, 3)) }
            val client = ProtoloomClient("http://127.0.0.1:${server.address.port}", "token")
            return assertFailsWith<GradleException> {
                client.publish("releases", Manifest("dev.surf.protection", "protection-contracts", "2.0.0", emptyList()), archive)
            }
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `validation failures list every issue on its own indented line`() {
        val body = """
            {"error":{"code":"validation_failed","message":"Proto validation failed","details":{"issues":[
              {"path":"surf/protection/v1/region.proto","line":5,"column":1,"message":"import \"surf/economy/v1/money.proto\": file does not exist"},
              {"path":"surf/protection/v1/zone.proto","message":"in dependency: syntax error"}
            ]}}}
        """.trimIndent()

        val error = publishAgainst(422, body)

        assertEquals(
            "validation_failed: Proto validation failed\n" +
                "  surf/protection/v1/region.proto:5: import \"surf/economy/v1/money.proto\": file does not exist\n" +
                "  surf/protection/v1/zone.proto: in dependency: syntax error",
            error.message,
        )
    }

    @Test
    fun `other errors keep the single-line code and message`() {
        val error = publishAgainst(409, """{"error":{"code":"immutable","message":"already exists","details":{"x":1}}}""")

        assertEquals("immutable: already exists", error.message)
    }
}
