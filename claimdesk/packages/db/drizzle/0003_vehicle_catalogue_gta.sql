CREATE TABLE `gta_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`group_code` text NOT NULL,
	`description` text,
	`daily_rate_pence` integer,
	`period` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text NOT NULL,
	`verification` text NOT NULL,
	`suppressed` integer DEFAULT false NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gta_rates_group_period_uq` ON `gta_rates` (`group_code`,`period`);--> statement-breakpoint
CREATE TABLE `gta_segment_defaults` (
	`segment` text PRIMARY KEY NOT NULL,
	`group_code` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vehicle_catalogue_custom` (
	`id` text PRIMARY KEY NOT NULL,
	`level` text NOT NULL,
	`make` text NOT NULL,
	`make_slug` text NOT NULL,
	`model` text,
	`model_slug` text,
	`generation_id` text,
	`name` text NOT NULL,
	`data` text NOT NULL,
	`segment` text,
	`gta_group` text,
	`overrides_builtin` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`deleted_at` text,
	`deleted_by` text
);
--> statement-breakpoint
CREATE INDEX `vehicle_catalogue_custom_make_idx` ON `vehicle_catalogue_custom` (`make_slug`,`model_slug`);--> statement-breakpoint
ALTER TABLE `vehicles` ADD `spec` text;