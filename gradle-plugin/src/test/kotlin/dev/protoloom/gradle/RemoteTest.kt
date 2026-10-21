package dev.protoloom.gradle

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.gradle.testkit.runner.GradleRunner
import org.gradle.testkit.runner.TaskOutcome
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetSocketAddress
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class RemoteTest {
    @TempDir
    lateinit var projectDir: File

    private lateinit var stub: RegistryStub

    @BeforeEach
    fun startStub() {
        stub = RegistryStub()
    }

    @AfterEach
    fun stopStub() {
        stub.close()
    }

    @Test
    fun `fetchProtos resolves the declared dependencies and extracts them into the proto root`() {
        writeBuild(
            """
            protoloom {
                repositories("releases")
            }
            dependencies {
                protoloom("dev.example:a:1.0.0")
            }
            """,
        )

        val result = gradle("fetchProtos").build()

        assertEquals(TaskOutcome.SUCCESS, result.task(":fetchProtos")?.outcome)
        assertEquals(1, stub.resolveBodies.size)
        assertEquals(
            Json.parseToJsonElement("""{"repositories":["releases"],"dependencies":["dev.example:a:1.0.0"]}"""),
            Json.parseToJsonElement(stub.resolveBodies.single()),
        )
        assertEquals(stub.protoContent, projectDir.resolve("build/protoloom/protos/a/v1/a.proto").readText())
        assertEquals(listOf("Bearer secret-token", "Bearer secret-token"), stub.authorizations.toList())
    }

    @Test
    fun `a second fetch reuses the cached archive`() {
        writeBuild(
            """
            protoloom {
                repositories("releases")
            }
            dependencies {
                protoloom("dev.example:a:1.0.0")
            }
            """,
        )

        gradle("fetchProtos").build()
        projectDir.resolve("build/protoloom/protos/a/v1/a.proto").delete()
        val second = gradle("fetchProtos").build()

        assertTrue(second.output.contains("Reusing configuration cache"), second.output)
        assertEquals(2, stub.resolveBodies.size)
        assertEquals(1, stub.archiveDownloads.get())
        assertEquals(stub.protoContent, projectDir.resolve("build/protoloom/protos/a/v1/a.proto").readText())
    }

    @Test
    fun `fetchProtos rejects an archive whose checksum differs from the resolved one`() {
        stub.corruptArchive = true
        writeBuild(
            """
            protoloom {
                repositories("releases")
            }
            dependencies {
                protoloom("dev.example:a:1.0.0")
            }
            """,
        )

        val result = gradle("fetchProtos").buildAndFail()

        assertTrue(result.output.contains("Checksum mismatch for dev.example:a:1.0.0"), result.output)
        assertFalse(projectDir.resolve("build/protoloom/protos/a/v1/a.proto").exists())
    }

    @Test
    fun `protosDir carries the fetchProtos task dependency`() {
        writeBuild(
            """
            protoloom {
                repositories("releases")
            }
            dependencies {
                protoloom("dev.example:a:1.0.0")
            }

            abstract class ReadProtos : DefaultTask() {
                @get:InputDirectory
                abstract val protos: DirectoryProperty

                @TaskAction
                fun read() {
                    println("read: " + protos.get().file("a/v1/a.proto").asFile.readText())
                }
            }

            tasks.register<ReadProtos>("readProtos") {
                protos.set(protoloom.protosDir)
            }
            """,
        )

        val result = gradle("readProtos").build()

        assertEquals(TaskOutcome.SUCCESS, result.task(":fetchProtos")?.outcome)
        assertTrue(result.output.contains("read: ${stub.protoContent}"), result.output)
    }

    @Test
    fun `publishProtos uploads the manifest and an archive with only the proto files`() {
        writeProtoSources()
        writeBuild(
            """
            protoloom {
                publishing {
                    repository = "releases"
                    group = "dev.example"
                    name = "b"
                    version = "1.0.0"
                }
            }
            dependencies {
                protoloom("dev.example:a:1.0.0")
            }
            """,
        )

        val result = gradle("publishProtos").build()

        assertEquals(TaskOutcome.SUCCESS, result.task(":publishProtos")?.outcome)
        val publish = stub.publishes.single()
        assertEquals("PUT", publish.method)
        assertEquals("/api/v1/repos/releases/artifacts/dev.example/b/1.0.0", publish.path)
        assertEquals("Bearer secret-token", publish.authorization)
        val parts = parseMultipart(publish.contentType, publish.body)
        val manifest = buildJsonObject {
            put("group", "dev.example")
            put("name", "b")
            put("version", "1.0.0")
            putJsonArray("dependencies") { add(JsonPrimitive("dev.example:a:1.0.0")) }
        }
        assertEquals<JsonElement>(manifest, Json.parseToJsonElement(parts.getValue("manifest").text))
        val archiveFiles = tarEntries(parts.getValue("archive").bytes).filter { it.isFile }.map { it.name }
        assertEquals(listOf("b/v1/b.proto", "b/v1/c.proto"), archiveFiles.sorted())
        assertTrue(result.output.contains("Published dev.example:b:1.0.0 to releases"), result.output)
    }

    @Test
    fun `publishProtos sends snapshot versions to the snapshot repository`() {
        writeProtoSources()
        writeBuild(
            """
            version = "1.1.0-SNAPSHOT"
            protoloom {
                publishing {
                    repository = "releases"
                    snapshotRepository = "snapshots"
                    group = "dev.example"
                    name = "b"
                }
            }
            """,
        )

        gradle("publishProtos").build()

        val publish = stub.publishes.single()
        assertEquals("/api/v1/repos/snapshots/artifacts/dev.example/b/1.1.0-SNAPSHOT", publish.path)
        val manifest = Json.parseToJsonElement(parseMultipart(publish.contentType, publish.body).getValue("manifest").text)
        assertEquals(JsonArray(emptyList()), (manifest as JsonObject).getValue("dependencies"))
    }

    @Test
    fun `a rejected publish fails the build with the registry error`() {
        stub.publishStatus = 409
        stub.publishResponse = """{"error":{"code":"immutable","message":"dev.example:b:1.0.0 already exists"}}"""
        writeProtoSources()
        writeBuild(
            """
            protoloom {
                publishing {
                    repository = "releases"
                    group = "dev.example"
                    name = "b"
                    version = "1.0.0"
                }
            }
            """,
        )

        val result = gradle("publishProtos").buildAndFail()

        assertTrue(result.output.contains("immutable: dev.example:b:1.0.0 already exists"), result.output)
    }

    @Test
    fun `a missing registry url names PROTOLOOM_URL`() {
        writeBuild(
            """
            protoloom {
                repositories("releases")
            }
            dependencies {
                protoloom("dev.example:a:1.0.0")
            }
            """,
        )

        val result = gradle("fetchProtos", env = System.getenv() - "PROTOLOOM_URL" - "PROTOLOOM_TOKEN").buildAndFail()

        assertTrue(result.output.contains("PROTOLOOM_URL"), result.output)
        assertEquals(0, stub.resolveBodies.size)
    }

    private fun writeBuild(body: String) {
        projectDir.resolve("settings.gradle.kts").writeText("""rootProject.name = "consumer"""" + "\n")
        projectDir.resolve("build.gradle.kts").writeText(
            "plugins {\n    id(\"dev.protoloom\")\n}\n" + body.trimIndent() + "\n",
        )
    }

    private fun writeProtoSources() {
        val root = projectDir.resolve("src/main/proto/b/v1").apply { mkdirs() }
        root.resolve("b.proto").writeText("syntax = \"proto3\";\npackage b.v1;\n")
        root.resolve("c.proto").writeText("syntax = \"proto3\";\npackage b.v1;\n")
        root.resolve("README.md").writeText("not a proto")
        projectDir.resolve("src/main/proto/notes.txt").writeText("not a proto either")
    }

    private fun gradle(
        vararg tasks: String,
        env: Map<String, String> = System.getenv() + mapOf("PROTOLOOM_URL" to stub.url, "PROTOLOOM_TOKEN" to "secret-token"),
    ): GradleRunner = GradleRunner.create()
        .withProjectDir(projectDir)
        .withPluginClasspath()
        .withEnvironment(env)
        .withArguments(*tasks, "--configuration-cache", "--stacktrace")
        .forwardOutput()

    private fun tarEntries(gzipped: ByteArray): List<TarArchiveEntry> =
        TarArchiveInputStream(GZIPInputStream(ByteArrayInputStream(gzipped))).use { tar ->
            generateSequence { tar.nextEntry }.toList()
        }

    private class Part(val bytes: ByteArray) {
        val text: String get() = bytes.toString(Charsets.UTF_8)
    }

    /** Splits a multipart/form-data body into its parts, keyed by field name. */
    private fun parseMultipart(contentType: String, body: ByteArray): Map<String, Part> {
        val boundary = contentType.substringAfter("boundary=").trim('"')
        val raw = body.toString(Charsets.ISO_8859_1)
        return raw.split("--$boundary")
            .drop(1)
            .filterNot { it.startsWith("--") }
            .associate { section ->
                val headers = section.substringBefore("\r\n\r\n")
                val content = section.substringAfter("\r\n\r\n").removeSuffix("\r\n")
                val name = Regex("name=\"([^\"]+)\"").find(headers)!!.groupValues[1]
                name to Part(content.toByteArray(Charsets.ISO_8859_1))
            }
    }

    private class CapturedRequest(
        val method: String,
        val path: String,
        val authorization: String?,
        val contentType: String,
        val body: ByteArray,
    )

    /** A minimal stand-in for the Protoloom REST API that records what the plugin sends. */
    private class RegistryStub : AutoCloseable {
        private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val url: String get() = "http://127.0.0.1:${server.address.port}"

        // Unique per test so the shared TestKit cache never already holds this archive.
        val protoContent = "syntax = \"proto3\";\npackage a.v1;\n// ${UUID.randomUUID()}\n"
        private val archive = tarGz(mapOf("a/v1/a.proto" to protoContent))
        private val sha256 = MessageDigest.getInstance("SHA-256").digest(archive).joinToString("") { "%02x".format(it) }

        val resolveBodies = CopyOnWriteArrayList<String>()
        val authorizations = CopyOnWriteArrayList<String?>()
        val archiveDownloads = AtomicInteger()
        val publishes = CopyOnWriteArrayList<CapturedRequest>()

        @Volatile var corruptArchive = false
        @Volatile var publishStatus = 201
        @Volatile var publishResponse = """{"coordinate":"dev.example:b:1.0.0","buildNumber":1,"sha256":"00","redeployed":false}"""

        init {
            server.createContext("/api/v1/resolve") { exchange ->
                authorizations += exchange.requestHeaders.getFirst("Authorization")
                resolveBodies += exchange.requestBody.readBytes().toString(Charsets.UTF_8)
                val body = """
                    {"artifacts":[{"repository":"releases","coordinate":"dev.example:a:1.0.0","group":"dev.example",
                    "name":"a","version":"1.0.0","buildNumber":1,"sha256":"$sha256",
                    "archiveUrl":"$url/api/v1/repos/releases/artifacts/dev.example/a/1.0.0/archive"}],"conflicts":[]}
                """.trimIndent()
                exchange.respond(200, "application/json", body.toByteArray())
            }
            server.createContext("/api/v1/repos/") { exchange ->
                when (exchange.requestMethod) {
                    "GET" -> {
                        authorizations += exchange.requestHeaders.getFirst("Authorization")
                        archiveDownloads.incrementAndGet()
                        val bytes = if (corruptArchive) tarGz(mapOf("a/v1/a.proto" to "tampered")) else archive
                        exchange.responseHeaders.add("x-protoloom-sha256", sha256)
                        exchange.respond(200, "application/gzip", bytes)
                    }
                    "PUT" -> {
                        publishes += CapturedRequest(
                            method = exchange.requestMethod,
                            path = exchange.requestURI.path,
                            authorization = exchange.requestHeaders.getFirst("Authorization"),
                            contentType = exchange.requestHeaders.getFirst("Content-Type"),
                            body = exchange.requestBody.readBytes(),
                        )
                        exchange.respond(publishStatus, "application/json", publishResponse.toByteArray())
                    }
                    else -> exchange.respond(405, "text/plain", ByteArray(0))
                }
            }
            server.start()
        }

        override fun close() = server.stop(0)

        private fun HttpExchange.respond(status: Int, contentType: String, body: ByteArray) {
            responseHeaders.add("Content-Type", contentType)
            sendResponseHeaders(status, if (body.isEmpty()) -1 else body.size.toLong())
            responseBody.use { it.write(body) }
        }

        private fun tarGz(files: Map<String, String>): ByteArray {
            val out = ByteArrayOutputStream()
            TarArchiveOutputStream(GZIPOutputStream(out)).use { tar ->
                files.forEach { (path, content) ->
                    val bytes = content.toByteArray()
                    tar.putArchiveEntry(TarArchiveEntry(path).apply { size = bytes.size.toLong() })
                    tar.write(bytes)
                    tar.closeArchiveEntry()
                }
            }
            return out.toByteArray()
        }
    }
}
