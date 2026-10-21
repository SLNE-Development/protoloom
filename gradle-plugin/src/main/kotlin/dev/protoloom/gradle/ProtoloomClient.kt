package dev.protoloom.gradle

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.gradle.api.GradleException
import org.gradle.api.logging.Logger
import org.gradle.api.logging.Logging
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.time.Duration
import java.util.UUID

/**
 * Body of `POST /api/v1/resolve`. [exclude] lists `group:name` keys the build provides itself: the
 * server does not look them up, does not resolve their dependencies, and never returns them.
 * An empty list is left out of the JSON.
 */
@Serializable
internal data class ResolveRequest(
    val repositories: List<String>,
    val dependencies: List<String>,
    val exclude: List<String> = emptyList(),
)

/** One artifact of a resolution, with the absolute URL of its archive. */
@Serializable
internal data class ResolvedArtifact(
    val repository: String,
    val coordinate: String,
    val group: String,
    val name: String,
    val version: String,
    val buildNumber: Int,
    val sha256: String,
    val archiveUrl: String,
)

/** Response of `POST /api/v1/resolve`; conflicts are passed through as reported by the server. */
@Serializable
internal data class ResolveResponse(val artifacts: List<ResolvedArtifact>, val conflicts: List<JsonElement> = emptyList())

/** The `manifest` part of a publish request. */
@Serializable
internal data class Manifest(val group: String, val name: String, val version: String, val dependencies: List<String>)

/** Response of a successful publish. */
@Serializable
internal data class PublishResponse(val coordinate: String, val buildNumber: Int, val sha256: String, val redeployed: Boolean)

@Serializable
private data class ErrorBody(val error: ErrorDetail)

@Serializable
private data class ErrorDetail(val code: String, val message: String, val details: JsonElement? = null)

/** One entry of `details.issues` in a `validation_failed` error body. */
@Serializable
private data class ValidationIssue(val path: String = "", val line: Int? = null, val message: String)

@Serializable
private data class ValidationDetails(val issues: List<ValidationIssue> = emptyList())

/**
 * Client for the Protoloom REST API (`/api/v1`). Every non-2xx response becomes a
 * [GradleException] of the form `<code>: <message>` taken from the server's error body; for
 * `validation_failed` each issue follows on its own line as `  <path>:<line>: <message>`.
 */
internal class ProtoloomClient(baseUrl: String, private val token: String?) {
    private val baseUrl = baseUrl.trimEnd('/')
    private val http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(30))
        .followRedirects(HttpClient.Redirect.NORMAL)
        .build()

    /**
     * Resolves [dependencies] (`g:n:v`) and their transitive dependencies across [repositories],
     * leaving out the `group:name` keys in [exclude] and the dependencies reached only through them.
     */
    fun resolve(repositories: List<String>, dependencies: List<String>, exclude: List<String> = emptyList()): ResolveResponse {
        val body = json.encodeToString(ResolveRequest.serializer(), ResolveRequest(repositories, dependencies, exclude))
        val request = request(URI.create("$baseUrl/api/v1/resolve"))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build()
        return decode(ResolveResponse.serializer(), sendForString(request, "resolve"))
    }

    /**
     * Downloads [artifact]'s archive to [target], verifying its SHA-256 against the resolved checksum.
     * The file only appears at [target] once it is complete and verified. The archive is always
     * requested from the configured server (see [archiveUri]), so the token never leaves its origin.
     */
    fun download(artifact: ResolvedArtifact, target: File) {
        target.parentFile.mkdirs()
        val temp = File(target.parentFile, "${target.name}.${UUID.randomUUID()}.tmp")
        try {
            val request = request(archiveUri(artifact.archiveUrl)).GET().build()
            val response = send(request, HttpResponse.BodyHandlers.ofFile(temp.toPath()), "download ${artifact.coordinate}")
            if (response.statusCode() !in 200..299) {
                throw errorFor(response.statusCode(), temp.readText(), "download ${artifact.coordinate}")
            }
            val actual = sha256(temp)
            if (!actual.equals(artifact.sha256, ignoreCase = true)) {
                throw GradleException(
                    "Checksum mismatch for ${artifact.coordinate}: expected ${artifact.sha256}, got $actual",
                )
            }
            Files.move(temp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } finally {
            temp.delete()
        }
    }

    /** Publishes [archive] (tar.gz) with [manifest] to [repository]. */
    fun publish(repository: String, manifest: Manifest, archive: File): PublishResponse {
        val path = listOf(repository, "artifacts", manifest.group, manifest.name, manifest.version)
            .joinToString("/") { URLEncoder.encode(it, StandardCharsets.UTF_8) }
        val boundary = "protoloom-${UUID.randomUUID()}"
        val manifestJson = json.encodeToString(Manifest.serializer(), manifest)
        val body = multipart(boundary, manifestJson, archive)
        val request = request(URI.create("$baseUrl/api/v1/repos/$path"))
            .header("Content-Type", "multipart/form-data; boundary=$boundary")
            .PUT(HttpRequest.BodyPublishers.ofByteArray(body))
            .build()
        return decode(PublishResponse.serializer(), sendForString(request, "publish"))
    }

    /**
     * Returns [archiveUrl] when it has the same scheme, host and port as the configured server.
     * Otherwise its path (from `/api/v1/` on, when present) and query are rebased onto the
     * configured URL, because the bearer token may only be sent to that origin.
     */
    internal fun archiveUri(archiveUrl: String): URI {
        val archive = try {
            URI.create(archiveUrl)
        } catch (e: IllegalArgumentException) {
            throw GradleException("Protoloom server returned an invalid archive URL: $archiveUrl", e)
        }
        val base = URI.create(baseUrl)
        if (sameOrigin(archive, base)) return archive
        val path = archive.rawPath.orEmpty()
        val apiPath = path.indexOf(API_PREFIX).let { if (it >= 0) path.substring(it) else path }
        val query = archive.rawQuery?.let { "?$it" }.orEmpty()
        val rebased = URI.create(baseUrl + apiPath + query)
        logger.info("Protoloom: archive URL {} is not on {}; requesting {} instead", archiveUrl, baseUrl, rebased)
        return rebased
    }

    private fun request(uri: URI): HttpRequest.Builder {
        val builder = HttpRequest.newBuilder(uri).timeout(Duration.ofMinutes(5))
        if (!token.isNullOrBlank()) builder.header("Authorization", "Bearer $token")
        return builder
    }

    private fun sendForString(request: HttpRequest, action: String): String {
        val response = send(request, HttpResponse.BodyHandlers.ofString(), action)
        if (response.statusCode() !in 200..299) throw errorFor(response.statusCode(), response.body(), action)
        return response.body()
    }

    private fun <T> send(request: HttpRequest, handler: HttpResponse.BodyHandler<T>, action: String): HttpResponse<T> =
        try {
            http.send(request, handler)
        } catch (e: IOException) {
            throw GradleException("Protoloom $action failed: could not reach ${request.uri()}: ${e.message}", e)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            throw GradleException("Protoloom $action was interrupted", e)
        }

    private fun errorFor(status: Int, body: String, action: String): GradleException {
        val error = try {
            json.decodeFromString(ErrorBody.serializer(), body).error
        } catch (_: SerializationException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }
        return if (error != null) {
            GradleException("${error.code}: ${error.message}" + validationIssueLines(error))
        } else {
            GradleException("Protoloom $action failed with HTTP $status: ${body.take(500)}")
        }
    }

    /** One `\n  <path>:<line>: <message>` line per issue of a `validation_failed` error (line and path left out when absent). */
    private fun validationIssueLines(error: ErrorDetail): String {
        if (error.code != "validation_failed" || error.details == null) return ""
        val issues = try {
            json.decodeFromJsonElement(ValidationDetails.serializer(), error.details).issues
        } catch (_: SerializationException) {
            return ""
        } catch (_: IllegalArgumentException) {
            return ""
        }
        return issues.joinToString("") { issue ->
            val location = listOfNotNull(issue.path.ifEmpty { null }, issue.line?.toString()).joinToString(":")
            if (location.isEmpty()) "\n  ${issue.message}" else "\n  $location: ${issue.message}"
        }
    }

    private fun <T> decode(serializer: KSerializer<T>, body: String): T =
        try {
            json.decodeFromString(serializer, body)
        } catch (e: SerializationException) {
            throw GradleException("Unexpected response from Protoloom server: ${e.message}", e)
        } catch (e: IllegalArgumentException) {
            throw GradleException("Unexpected response from Protoloom server: ${e.message}", e)
        }

    private fun multipart(boundary: String, manifestJson: String, archive: File): ByteArray {
        val out = ByteArrayOutputStream()
        fun write(text: String) = out.write(text.toByteArray(StandardCharsets.UTF_8))
        write("--$boundary\r\n")
        write("Content-Disposition: form-data; name=\"manifest\"\r\n")
        write("Content-Type: application/json\r\n\r\n")
        write(manifestJson)
        write("\r\n--$boundary\r\n")
        write("Content-Disposition: form-data; name=\"archive\"; filename=\"${archive.name}\"\r\n")
        write("Content-Type: application/gzip\r\n\r\n")
        out.write(archive.readBytes())
        write("\r\n--$boundary--\r\n")
        return out.toByteArray()
    }

    private companion object {
        const val API_PREFIX = "/api/v1/"
        val json = Json { ignoreUnknownKeys = true }
        val logger: Logger = Logging.getLogger(ProtoloomClient::class.java)

        fun sameOrigin(a: URI, b: URI): Boolean =
            a.scheme.equals(b.scheme, ignoreCase = true) &&
                a.host.equals(b.host, ignoreCase = true) &&
                effectivePort(a) == effectivePort(b)

        fun effectivePort(uri: URI): Int = when {
            uri.port != -1 -> uri.port
            uri.scheme.equals("https", ignoreCase = true) -> 443
            uri.scheme.equals("http", ignoreCase = true) -> 80
            else -> -1
        }

        fun sha256(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
    }
}

/** Creates a client for [url], failing with a hint at `PROTOLOOM_URL` when no URL is configured. */
internal fun protoloomClient(url: String?, token: String?): ProtoloomClient {
    if (url.isNullOrBlank()) {
        throw GradleException("No Protoloom server URL configured. Set the PROTOLOOM_URL environment variable or protoloom.url.")
    }
    return ProtoloomClient(url, token)
}
