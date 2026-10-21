package dev.protoloom.gradle

import org.gradle.api.GradleException
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import kotlin.test.assertEquals

class CoordinatesTest {
    @Test
    fun `an external dependency maps to group name version`() {
        assertEquals("dev.example:a:1.0.0", externalCoordinate("dev.example", "a", "1.0.0"))
    }

    @Test
    fun `an external dependency without a group fails clearly`() {
        val missing = assertThrows<GradleException> { externalCoordinate(null, "a", "1") }
        assertEquals("protoloom dependency a:1 needs a group (group:name:version).", missing.message)
        assertThrows<GradleException> { externalCoordinate(" ", "a", "1") }
    }

    @Test
    fun `an external dependency without a version fails clearly`() {
        val missing = assertThrows<GradleException> { externalCoordinate("dev.example", "a", null) }
        assertEquals("protoloom dependency dev.example:a needs a version.", missing.message)
    }

    @Test
    fun `a local module replaces remote artifacts with its group and name in any version`() {
        val x = artifact("dev.example", "x", "1.0.0")
        val contracts = artifact("dev.example", "contracts", "0.9.0")
        val other = artifact("dev.other", "contracts", "1.0.0")

        val result = substituteLocalModules(
            listOf(x, contracts, other),
            listOf(LocalModule(":contracts", "dev.example:contracts:1.0.0"), LocalModule(":api", null)),
        )

        assertEquals(listOf(x, other), result.remote)
        assertEquals(listOf(":contracts" to contracts), result.substitutions.map { it.project to it.artifact })
    }

    @Test
    fun `local modules without a coordinate substitute nothing`() {
        val contracts = artifact("dev.example", "contracts", "1.0.0")

        val result = substituteLocalModules(listOf(contracts), listOf(LocalModule(":contracts", null)))

        assertEquals(listOf(contracts), result.remote)
        assertEquals(emptyList(), result.substitutions)
    }

    private fun artifact(group: String, name: String, version: String) = ResolvedArtifact(
        repository = "releases",
        coordinate = "$group:$name:$version",
        group = group,
        name = name,
        version = version,
        buildNumber = 1,
        sha256 = "0".repeat(64),
        archiveUrl = "http://localhost/archive",
    )
}
