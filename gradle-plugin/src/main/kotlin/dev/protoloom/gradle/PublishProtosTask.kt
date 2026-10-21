package dev.protoloom.gradle

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.ArchiveOperations
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.gradle.work.DisableCachingByDefault
import javax.inject.Inject

/**
 * Uploads the packed `.proto` archive with a manifest built from `protoloom.publishing` and the
 * `protoloom` dependencies. `-SNAPSHOT` versions go to the snapshot repository when one is set.
 */
@DisableCachingByDefault(because = "Uploads to a remote registry")
abstract class PublishProtosTask : DefaultTask() {
    @get:Input
    @get:Optional
    abstract val url: Property<String>

    @get:Internal
    abstract val token: Property<String>

    @get:Input
    @get:Optional
    abstract val repository: Property<String>

    @get:Input
    @get:Optional
    abstract val snapshotRepository: Property<String>

    @get:Input
    @get:Optional
    abstract val artifactGroup: Property<String>

    @get:Input
    @get:Optional
    abstract val artifactName: Property<String>

    @get:Input
    @get:Optional
    abstract val artifactVersion: Property<String>

    /** Declared dependencies (`g:n:v`) written into the manifest. */
    @get:Input
    abstract val dependencies: ListProperty<String>

    /** The tar.gz produced by `packProtos`. */
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val archive: RegularFileProperty

    @get:Inject
    protected abstract val archiveOperations: ArchiveOperations

    @TaskAction
    fun publish() {
        val version = required(artifactVersion, "version")
        val manifest = Manifest(
            group = required(artifactGroup, "group"),
            name = required(artifactName, "name"),
            version = version,
            dependencies = dependencies.get(),
        )
        val target = if (version.endsWith("-SNAPSHOT")) {
            snapshotRepository.orNull ?: required(repository, "repository")
        } else {
            required(repository, "repository")
        }
        val archiveFile = archive.get().asFile
        if (archiveOperations.tarTree(archiveOperations.gzip(archiveFile)).isEmpty) {
            throw GradleException("No .proto files found in protoloom.publishing.source.")
        }

        val client = protoloomClient(url.orNull, token.orNull)
        val result = client.publish(target, manifest, archiveFile)
        val redeployed = if (result.redeployed) " (redeployed)" else ""
        logger.lifecycle("Published ${result.coordinate} to $target, build ${result.buildNumber}$redeployed")
    }

    private fun required(property: Property<String>, name: String): String =
        property.orNull?.takeIf { it.isNotBlank() }
            ?: throw GradleException("protoloom.publishing.$name is not set.")
}
