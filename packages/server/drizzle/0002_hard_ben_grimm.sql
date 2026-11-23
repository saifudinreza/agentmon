CREATE TABLE "device_e2e" (
	"machine_id" text NOT NULL,
	"device_id" text NOT NULL,
	"device_name" text NOT NULL,
	"kx_public_key" text NOT NULL,
	"sign_public_key" text NOT NULL,
	"proof" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_e2e_machine_id_device_id_pk" PRIMARY KEY("machine_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "e2e_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"machine_id" text NOT NULL,
	"device_id" text NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "e2e_messages_kind_known" CHECK ("e2e_messages"."kind" in ('challenge', 'response', 'keys'))
);
--> statement-breakpoint
ALTER TABLE "pairings" ADD COLUMN "code_hash" text;--> statement-breakpoint
ALTER TABLE "device_e2e" ADD CONSTRAINT "device_e2e_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_e2e" ADD CONSTRAINT "device_e2e_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e2e_messages" ADD CONSTRAINT "e2e_messages_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e2e_messages" ADD CONSTRAINT "e2e_messages_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "e2e_messages_device_idx" ON "e2e_messages" USING btree ("machine_id","device_id","id");