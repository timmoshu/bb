CREATE TABLE `work_together_thread_contexts` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`request_id` text,
	`digest` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
