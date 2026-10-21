package dev.protoloom.gradle

import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.artifacts.ExternalModuleDependency
import org.gradle.api.tasks.bundling.Compression
import org.gradle.api.tasks.bundling.Tar
import java.io.File

/**
 * Adds the `protoloom` extension, the declarable `protoloom` configuration for proto dependencies,
 * and the `fetchProtos` and `publishProtos` tasks.
 */
class ProtoloomPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val extension = project.extensions.create(EXTENSION, ProtoloomExtension::class.java)
        extension.url.convention(project.providers.environmentVariable("PROTOLOOM_URL"))
        extension.token.convention(project.providers.environmentVariable("PROTOLOOM_TOKEN"))
        extension.publishing.version.convention(
            project.provider { project.version.toString() }.filter { it != Project.DEFAULT_VERSION },
        )
        extension.publishing.source.convention(project.layout.projectDirectory.dir("src/main/proto"))

        val protoloom = project.configurations.dependencyScope(CONFIGURATION) {
            description = "Proto bundles (group:name:version) to fetch and to declare as dependencies when publishing."
        }
        val externalCoordinates = protoloom.map { configuration ->
            configuration.dependencies.withType(ExternalModuleDependency::class.java).map { dependency ->
                val version = dependency.version?.takeIf { it.isNotBlank() }
                    ?: throw GradleException("protoloom dependency ${dependency.group}:${dependency.name} needs a version.")
                "${dependency.group}:${dependency.name}:$version"
            }
        }

        val fetchProtos = project.tasks.register("fetchProtos", FetchProtosTask::class.java) {
            group = TASK_GROUP
            description = "Resolves the protoloom dependencies and extracts them into build/protoloom/protos."
            url.set(extension.url)
            token.set(extension.token)
            repositories.set(extension.repositories)
            dependencies.set(externalCoordinates)
            cacheDir.set(File(project.gradle.gradleUserHomeDir, "caches/protoloom"))
            outputDir.set(project.layout.buildDirectory.dir("protoloom/protos"))
        }
        extension.protosDirFrom(fetchProtos.flatMap { it.outputDir })

        val packProtos = project.tasks.register("packProtos", Tar::class.java) {
            group = TASK_GROUP
            description = "Packs the .proto files of protoloom.publishing.source into a reproducible tar.gz."
            from(extension.publishing.source) { include("**/*.proto") }
            includeEmptyDirs = false
            compression = Compression.GZIP
            isPreserveFileTimestamps = false
            isReproducibleFileOrder = true
            destinationDirectory.set(project.layout.buildDirectory.dir("protoloom/publish"))
            archiveFileName.set("protos.tar.gz")
        }

        project.tasks.register("publishProtos", PublishProtosTask::class.java) {
            group = TASK_GROUP
            description = "Publishes the .proto files to the Protoloom registry."
            url.set(extension.url)
            token.set(extension.token)
            repository.set(extension.publishing.repository)
            snapshotRepository.set(extension.publishing.snapshotRepository)
            artifactGroup.set(extension.publishing.group)
            artifactName.set(extension.publishing.name)
            artifactVersion.set(extension.publishing.version)
            dependencies.set(externalCoordinates)
            archive.set(packProtos.flatMap { it.archiveFile })
        }
    }

    companion object {
        const val EXTENSION = "protoloom"
        const val CONFIGURATION = "protoloom"
        const val TASK_GROUP = "protoloom"
    }
}
