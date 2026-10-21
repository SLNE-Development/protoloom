package dev.protoloom.gradle

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.ArchiveOperations
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.DuplicatesStrategy
import org.gradle.api.file.FileSystemOperations
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.TaskAction
import org.gradle.work.DisableCachingByDefault
import java.io.File
import javax.inject.Inject

/**
 * Resolves the `protoloom` dependencies on the server and extracts every resolved artifact into one
 * merged proto root. Archives are cached by checksum, so releases download once while snapshots are
 * re-checked on every run through `/resolve`.
 */
@DisableCachingByDefault(because = "Always re-resolves against the registry; archives are cached by checksum instead")
abstract class FetchProtosTask : DefaultTask() {
    @get:Input
    @get:Optional
    abstract val url: Property<String>

    @get:Internal
    abstract val token: Property<String>

    @get:Input
    abstract val repositories: ListProperty<String>

    /** Root coordinates (`g:n:v`) to resolve. */
    @get:Input
    abstract val dependencies: ListProperty<String>

    /** Content-addressed archive cache, `<gradleUserHome>/caches/protoloom`. */
    @get:Internal
    abstract val cacheDir: DirectoryProperty

    /** The merged proto root, `build/protoloom/protos`. */
    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    protected abstract val archiveOperations: ArchiveOperations

    @get:Inject
    protected abstract val fileSystemOperations: FileSystemOperations

    init {
        outputs.upToDateWhen { false }
    }

    @TaskAction
    fun fetch() {
        val roots = dependencies.get()
        if (roots.isEmpty()) {
            fileSystemOperations.delete { delete(outputDir) }
            outputDir.get().asFile.mkdirs()
            return
        }
        val repos = repositories.get()
        if (repos.isEmpty()) {
            throw GradleException("protoloom.repositories is empty. Add the repositories to resolve from, for example repositories(\"releases\").")
        }

        val client = protoloomClient(url.orNull, token.orNull)
        val resolution = client.resolve(repos, roots)
        resolution.conflicts.forEach { logger.lifecycle("Protoloom resolved a version conflict: $it") }

        val archives = resolution.artifacts.map { artifact -> artifact to cachedArchive(client, artifact) }
        checkForCollisions(archives)

        fileSystemOperations.sync {
            into(outputDir)
            duplicatesStrategy = DuplicatesStrategy.FAIL
            archives.forEach { (_, archive) -> from(archiveOperations.tarTree(archiveOperations.gzip(archive))) }
        }
    }

    private fun cachedArchive(client: ProtoloomClient, artifact: ResolvedArtifact): File {
        if (!SHA256.matches(artifact.sha256)) {
            throw GradleException("Protoloom server returned an invalid checksum for ${artifact.coordinate}: ${artifact.sha256}")
        }
        val file = cacheDir.file("${artifact.sha256}.tar.gz").get().asFile
        if (file.isFile) {
            logger.info("Protoloom: using cached {} ({})", artifact.coordinate, artifact.sha256)
        } else {
            logger.lifecycle("Protoloom: downloading {}", artifact.coordinate)
            client.download(artifact, file)
        }
        return file
    }

    /** Fails when two artifacts contain the same file path, naming both. */
    private fun checkForCollisions(archives: List<Pair<ResolvedArtifact, File>>) {
        val owners = mutableMapOf<String, String>()
        archives.forEach { (artifact, archive) ->
            archiveOperations.tarTree(archiveOperations.gzip(archive)).visit {
                if (!isDirectory) {
                    val previous = owners.put(relativePath.pathString, artifact.coordinate)
                    if (previous != null) {
                        throw GradleException("File ${relativePath.pathString} is provided by both $previous and ${artifact.coordinate}")
                    }
                }
            }
        }
    }

    private companion object {
        val SHA256 = Regex("^[0-9a-f]{64}$")
    }
}
