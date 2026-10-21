package dev.protoloom.gradle

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.ArchiveOperations
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.DuplicatesStrategy
import org.gradle.api.file.FileSystemOperations
import org.gradle.api.file.FileTree
import org.gradle.api.model.ObjectFactory
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.MapProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.gradle.work.DisableCachingByDefault
import java.io.File
import javax.inject.Inject

/**
 * Builds one merged proto root from the `protoloom` dependencies: the `.proto` files of local
 * modules are copied as they are, and the remote dependencies (this module's own plus those of all
 * local modules) are resolved on the server in one `/resolve` call and extracted next to them.
 * A resolved artifact with the `group:name` of a local module's publishing coordinate is replaced
 * by that module and never downloaded. Archives are cached by checksum, so releases download once
 * while snapshots are re-checked on every run through `/resolve`.
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

    /** This module's direct external coordinates (`g:n:v`) to resolve. */
    @get:Input
    abstract val dependencies: ListProperty<String>

    /** Proto source directories of the local modules this module depends on. */
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val localSources: ConfigurableFileCollection

    /** Absolute path of each [localSources] directory → project path, used to name it in errors. */
    @get:Internal
    abstract val localSourceProjects: MapProperty<String, String>

    /** [LocalManifest]s of the local modules; their `external` lists join the resolved roots. */
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val localManifests: ConfigurableFileCollection

    /** Absolute path of each [localManifests] file → project path, used to name substitutions. */
    @get:Internal
    abstract val localManifestProjects: MapProperty<String, String>

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

    @get:Inject
    protected abstract val objects: ObjectFactory

    init {
        outputs.upToDateWhen { false }
    }

    @TaskAction
    fun fetch() {
        val manifestProjects = localManifestProjects.get()
        val manifests = localManifests.files.sorted().map { file ->
            val manifest = readLocalManifest(file)
            LocalModule(manifestProjects[file.absolutePath] ?: file.path, manifest.coordinate) to manifest
        }
        val roots = (dependencies.get() + manifests.flatMap { it.second.external }).distinct()
        val origins = localSourceProjects.get()
        val local = localSources.files.sorted().filter { it.isDirectory }.map { dir ->
            Origin(origins[dir.absolutePath]?.let { "project $it" } ?: dir.path, protoFiles(dir))
        }
        val remote = if (roots.isEmpty()) emptyList() else fetchRemote(roots, manifests.map { it.first })

        val sources = local + remote
        checkForCollisions(sources)
        fileSystemOperations.sync {
            into(outputDir)
            duplicatesStrategy = DuplicatesStrategy.FAIL
            sources.forEach { from(it.files) }
        }
        outputDir.get().asFile.mkdirs()
    }

    private fun fetchRemote(roots: List<String>, localModules: List<LocalModule>): List<Origin> {
        val repos = repositories.get()
        if (repos.isEmpty()) {
            throw GradleException("protoloom.repositories is empty. Add the repositories to resolve from, for example repositories(\"releases\").")
        }
        val client = protoloomClient(url.orNull, token.orNull)
        val resolution = client.resolve(repos, roots)
        resolution.conflicts.forEach { logger.lifecycle("Protoloom resolved a version conflict: $it") }
        val substituted = substituteLocalModules(resolution.artifacts, localModules)
        substituted.substitutions.forEach { logger.info("Using project {} instead of {}", it.project, it.artifact.coordinate) }
        return substituted.remote.map { artifact ->
            Origin(artifact.coordinate, archiveOperations.tarTree(archiveOperations.gzip(cachedArchive(client, artifact))))
        }
    }

    /** The `.proto` files of a local module's source directory, the same set `packProtos` would publish. */
    private fun protoFiles(dir: File): FileTree =
        objects.fileTree().from(dir).matching { include(ProtoloomPlugin.PROTO_PATTERN) }

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

    /** Fails when two origins (local modules or remote artifacts) contain the same file path, naming both. */
    private fun checkForCollisions(sources: List<Origin>) {
        val owners = mutableMapOf<String, String>()
        sources.forEach { source ->
            source.files.visit {
                if (!isDirectory) {
                    val previous = owners.put(relativePath.pathString, source.name)
                    if (previous != null) {
                        throw GradleException("File ${relativePath.pathString} is provided by both $previous and ${source.name}")
                    }
                }
            }
        }
    }

    /** Files contributed to the proto root, with the name of where they come from. */
    private class Origin(val name: String, val files: FileTree)

    private companion object {
        val SHA256 = Regex("^[0-9a-f]{64}$")
    }
}

/** A local module this module depends on: its project path and its publishing coordinate, if any. */
internal class LocalModule(val project: String, val coordinate: String?)

/** A remote artifact that [project] replaces. */
internal class Substitution(val project: String, val artifact: ResolvedArtifact)

/** The remote artifacts left to download, and the ones local modules replaced. */
internal class SubstitutionResult(val remote: List<ResolvedArtifact>, val substitutions: List<Substitution>)

/**
 * Replaces every resolved artifact whose `group:name` is the publishing coordinate of a local
 * module, regardless of version, the way Gradle substitutes included builds. Local modules without
 * a coordinate replace nothing.
 */
internal fun substituteLocalModules(artifacts: List<ResolvedArtifact>, localModules: List<LocalModule>): SubstitutionResult {
    val projectsByModule = localModules
        .mapNotNull { module -> module.coordinate?.let { it.substringBeforeLast(':') to module.project } }
        .toMap()
    val substitutions = mutableListOf<Substitution>()
    val remote = artifacts.filter { artifact ->
        val project = projectsByModule["${artifact.group}:${artifact.name}"]
        if (project != null) substitutions += Substitution(project, artifact)
        project == null
    }
    return SubstitutionResult(remote, substitutions)
}
