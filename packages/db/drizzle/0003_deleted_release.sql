CREATE TABLE "deleted_release" (
	"repository_id" uuid NOT NULL,
	"group" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"sha256" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deleted_release_repository_id_group_name_version_pk" PRIMARY KEY("repository_id","group","name","version")
);
--> statement-breakpoint
ALTER TABLE "deleted_release" ADD CONSTRAINT "deleted_release_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;