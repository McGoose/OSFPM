CREATE TABLE "retention_class" (
	"key" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"anchor" text NOT NULL,
	CONSTRAINT "retention_class_anchor_check" CHECK ("retention_class"."anchor" in ('record-created', 'project-wrap', 'project-delivery', 'first-exploitation', 'last-activity'))
);
