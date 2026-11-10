CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"public_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "devices_token_hash_is_sha256" CHECK ("devices"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "events" (
	"machine_id" text NOT NULL,
	"id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"agent" text NOT NULL,
	"type" text NOT NULL,
	"payload" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_machine_id_id_pk" PRIMARY KEY("machine_id","id"),
	CONSTRAINT "events_seq_not_negative" CHECK ("events"."seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "machines_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "machines_token_hash_is_sha256" CHECK ("machines"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"machine_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pairing_codes_code_hash_is_sha256" CHECK ("pairing_codes"."code_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "pairings" (
	"machine_id" text NOT NULL,
	"device_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pairings_machine_id_device_id_pk" PRIMARY KEY("machine_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"machine_id" text NOT NULL,
	"session_id" text NOT NULL,
	"agent" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "sessions_machine_id_session_id_pk" PRIMARY KEY("machine_id","session_id"),
	CONSTRAINT "sessions_status_known" CHECK ("sessions"."status" in ('active', 'ended')),
	CONSTRAINT "sessions_agent_known" CHECK ("sessions"."agent" in ('claude-code', 'codex'))
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_machine_id_session_id_sessions_machine_id_session_id_fk" FOREIGN KEY ("machine_id","session_id") REFERENCES "public"."sessions"("machine_id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairings" ADD CONSTRAINT "pairings_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairings" ADD CONSTRAINT "pairings_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_session_seq_idx" ON "events" USING btree ("machine_id","session_id","seq");--> statement-breakpoint
CREATE INDEX "events_received_idx" ON "events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "pairing_codes_expires_idx" ON "pairing_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "pairings_device_idx" ON "pairings" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_device_idx" ON "push_subscriptions" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "sessions_last_event_idx" ON "sessions" USING btree ("machine_id","last_event_at");