CREATE TABLE `document_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`recipient_role` text,
	`file_name` text NOT NULL,
	`file_path` text,
	`sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	`file_version` integer DEFAULT 1 NOT NULL,
	`mapping_revision` integer DEFAULT 0 NOT NULL,
	`scan_version` integer NOT NULL,
	`scan` text NOT NULL,
	`mapping` text,
	`warnings` text DEFAULT '[]' NOT NULL,
	`warnings_acknowledged_at` text,
	`warnings_acknowledged_by` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `document_templates_source_idx` ON `document_templates` (`source`);--> statement-breakpoint
CREATE INDEX `document_templates_sha_idx` ON `document_templates` (`sha256`);--> statement-breakpoint
ALTER TABLE `documents` ADD `format` text DEFAULT 'html' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `docx_path` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `docx_sha256` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `pdf_converter` text;