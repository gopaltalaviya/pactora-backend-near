CREATE TABLE "channel_failures" (
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_failures_channel_address_pk" PRIMARY KEY("channel","address")
);
--> statement-breakpoint
CREATE TABLE "channel_inbox" (
	"channel" text NOT NULL,
	"update_id" bigint NOT NULL,
	"address" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"handled" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_inbox_channel_update_id_pk" PRIMARY KEY("channel","update_id")
);
--> statement-breakpoint
CREATE TABLE "channel_links" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" bigint NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"cursor_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_until" timestamp with time zone,
	"error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "link_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"agent_id" bigint NOT NULL,
	"channel" text NOT NULL,
	"secret" text NOT NULL,
	"pending_address" text,
	"address" text,
	"tries" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_links" ADD CONSTRAINT "channel_links_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_codes" ADD CONSTRAINT "link_codes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_inbox_address_idx" ON "channel_inbox" USING btree ("channel","address","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_links_address_uk" ON "channel_links" USING btree ("channel","address");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_links_agent_uk" ON "channel_links" USING btree ("agent_id","channel");--> statement-breakpoint
CREATE INDEX "channel_outbox_due_idx" ON "channel_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "link_codes_agent_idx" ON "link_codes" USING btree ("agent_id","created_at");